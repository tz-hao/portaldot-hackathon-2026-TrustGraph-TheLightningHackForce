import json
import os
import time
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

import requests
from dotenv import load_dotenv
from scalecodec.base import ScaleBytes
from substrateinterface import SubstrateInterface
from substrateinterface.utils.ss58 import ss58_encode

from database import IdentityIpfsMigration, IndexedEndorsement, IndexedIdentity, SessionLocal, SyncState


def _fix_double_encoded_utf8(text: str) -> str:
    """Repair a string that has been double-encoded (UTF-8 bytes treated as Latin-1)."""
    if not text:
        return text
    try:
        repaired = text.encode("latin-1").decode("utf-8")
        if repaired != text:
            return repaired
    except (UnicodeDecodeError, UnicodeEncodeError):
        pass
    return text


PROJECT_ROOT = Path(__file__).resolve().parents[1]
load_dotenv(Path(__file__).resolve().with_name(".env"))

RPC_URL = os.getenv("RPC_URL", os.getenv("RPC_ENDPOINT", "ws://127.0.0.1:9944"))
CONTRACT_ADDRESS = os.getenv(
    "CONTRACT_ADDRESS",
    "5CqYubyHiCH2bYmTfeLCcLhtBbMJCDHfmHdZWdDd1a5xqUme",
)
METADATA_PATH = Path(
    os.getenv(
        "CONTRACT_METADATA_PATH",
        str(PROJECT_ROOT / "trustgraph-contract" / "target" / "ink" / "trustgraph.json"),
    )
)
IPFS_API_URL = os.getenv("IPFS_API_URL", "http://127.0.0.1:5001")
INDEXER_POLL_INTERVAL = float(os.getenv("INDEXER_POLL_INTERVAL", "3"))
INDEXER_BATCH_SIZE = int(os.getenv("INDEXER_BATCH_SIZE", "10"))


def relation_label(relation_type: int) -> str:
    mapping = {
        0: "COLLABORATION",
        1: "ENDORSEMENT",
        2: "CONTRIBUTION",
    }
    return mapping.get(relation_type, f"RELATION_{relation_type}")


def is_probable_ipfs_cid(value: str) -> bool:
    if not value:
        return False
    return value.startswith("Qm") or value.startswith("bafy")


def upload_json_to_ipfs(payload: dict[str, Any]) -> dict[str, Any]:
    content = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    response = requests.post(
        f"{IPFS_API_URL}/api/v0/add",
        params={"pin": "true"},
        files={"file": ("trustgraph-profile.json", content, "application/json")},
        timeout=20,
    )
    response.raise_for_status()
    parsed = response.json()
    return {
        "cid": parsed["Hash"],
        "size": parsed.get("Size"),
        "name": parsed.get("Name"),
    }


def read_ipfs_text(cid: str) -> Optional[str]:
    try:
        response = requests.post(
            f"{IPFS_API_URL}/api/v0/cat",
            params={"arg": cid},
            timeout=20,
        )
        response.raise_for_status()
        return response.text
    except requests.RequestException:
        return None


def ipfs_is_available() -> bool:
    try:
        response = requests.post(f"{IPFS_API_URL}/api/v0/version", timeout=5)
        response.raise_for_status()
        return True
    except requests.RequestException:
        return False


def resolve_profile_payload(raw_value: str) -> tuple[Optional[dict[str, Any]], str]:
    if not raw_value:
        return None, ""

    if is_probable_ipfs_cid(raw_value):
        content = read_ipfs_text(raw_value)
        if not content:
            return None, raw_value
        try:
            return json.loads(content), raw_value
        except json.JSONDecodeError:
            return None, raw_value

    try:
        return json.loads(raw_value), raw_value
    except json.JSONDecodeError:
        return None, raw_value


def normalize_profile_payload(raw_value: str) -> dict[str, Any]:
    payload, _ = resolve_profile_payload(raw_value)
    if payload is not None:
        return payload
    return {
        "name": "",
        "metadata": raw_value,
    }


class ContractChainIndexer:
    def __init__(self):
        self.substrate: Optional[SubstrateInterface] = None
        self.running = False
        self.thread: Optional[threading.Thread] = None
        self.last_error: Optional[str] = None
        self._last_logged_error: Optional[str] = None

    def ensure_ready(self):
        if self.substrate is None:
            try:
                self.substrate = SubstrateInterface(url=RPC_URL, type_registry_preset="canvas")
            except Exception as exc:
                msg = str(exc)
                if "10061" in msg or "actively refused" in msg.lower() or "connection refused" in msg.lower():
                    raise ConnectionRefusedError(f"Substrate node not reachable at {RPC_URL} — is substrate-contracts-node --dev running?")
                raise

    def start(self):
        if self.thread and self.thread.is_alive():
            return

        self.running = True
        self.thread = threading.Thread(target=self._run_loop, daemon=True)
        self.thread.start()

    def stop(self):
        self.running = False
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=1)

    def _run_loop(self):
        while self.running:
            try:
                self.sync_once()
                self.last_error = None
                self._last_logged_error = None
            except Exception as exc:
                self.last_error = str(exc)
                err_str = str(exc)
                if err_str != self._last_logged_error:
                    print(f"[WARN] Indexer error: {exc}")
                    self._last_logged_error = err_str
            time.sleep(INDEXER_POLL_INTERVAL)

    def get_status(self) -> dict[str, Any]:
        db = SessionLocal()
        try:
            sync_state = db.get(SyncState, 1)
            last_processed_block = sync_state.last_processed_block if sync_state else 0
        finally:
            db.close()

        current_block = None
        chain_available = False
        try:
            self.ensure_ready()
            current_block = self.substrate.get_block_number(None)
            chain_available = True
        except Exception as exc:
            if not self.last_error:
                self.last_error = str(exc)

        return {
            "running": bool(self.thread and self.thread.is_alive()),
            "rpcUrl": RPC_URL,
            "contractAddress": CONTRACT_ADDRESS,
            "metadataPath": str(METADATA_PATH),
            "lastProcessedBlock": last_processed_block,
            "currentBlock": current_block,
            "lastError": self.last_error,
            "ipfsApiUrl": IPFS_API_URL,
            "chainAvailable": chain_available,
            "ipfsAvailable": ipfs_is_available(),
            "indexerHealthy": bool(self.thread and self.thread.is_alive()) and self.last_error is None,
        }

    def sync_once(self):
        self.ensure_ready()

        db = SessionLocal()
        try:
            sync_state = db.get(SyncState, 1)
            if sync_state is None:
                sync_state = SyncState(id=1, last_processed_block=0)
                db.add(sync_state)
                db.commit()
                db.refresh(sync_state)

            current_block = self.substrate.get_block_number(None)
            if current_block <= sync_state.last_processed_block:
                return

            blocks_processed = 0
            for block_num in range(sync_state.last_processed_block + 1, current_block + 1):
                self._process_block(db, block_num)
                sync_state.last_processed_block = block_num
                blocks_processed += 1

                if blocks_processed % INDEXER_BATCH_SIZE == 0:
                    db.commit()

            if blocks_processed % INDEXER_BATCH_SIZE != 0:
                db.commit()
        finally:
            db.close()

    def reset(self):
        db = SessionLocal()
        try:
            db.query(IndexedEndorsement).delete()
            db.query(IndexedIdentity).delete()
            sync_state = db.get(SyncState, 1)
            if sync_state is None:
                sync_state = SyncState(id=1, last_processed_block=0)
                db.add(sync_state)
            else:
                sync_state.last_processed_block = 0
            db.commit()
        finally:
            db.close()

    def recompute_degrees(self):
        """一次性从 endorsements 表重新计算所有身份的 in_degree / out_degree。"""
        db = SessionLocal()
        try:
            identities = db.query(IndexedIdentity).all()
            for identity in identities:
                identity.in_degree = (
                    db.query(IndexedEndorsement)
                    .filter(IndexedEndorsement.to_address == identity.address)
                    .count()
                )
                identity.out_degree = (
                    db.query(IndexedEndorsement)
                    .filter(IndexedEndorsement.from_address == identity.address)
                    .count()
                )
            db.commit()
        finally:
            db.close()

    def migrate_inline_identities_to_ipfs(self) -> dict[str, Any]:
        db = SessionLocal()
        try:
            identities = db.query(IndexedIdentity).order_by(IndexedIdentity.registered_at.asc()).all()
            migrated = []
            skipped = []

            for identity in identities:
                current_value = identity.ipfs_cid or ""
                if is_probable_ipfs_cid(current_value):
                    skipped.append({"address": identity.address, "reason": "already_cid", "value": current_value})
                    continue

                payload = normalize_profile_payload(current_value)
                existing = (
                    db.query(IdentityIpfsMigration)
                    .filter(
                        IdentityIpfsMigration.address == identity.address,
                        IdentityIpfsMigration.source_value == current_value,
                    )
                    .first()
                )
                if existing is None:
                    upload = upload_json_to_ipfs(payload)
                    existing = IdentityIpfsMigration(
                        address=identity.address,
                        source_value=current_value,
                        migrated_cid=upload["cid"],
                        profile_json=json.dumps(payload, ensure_ascii=False),
                    )
                    db.add(existing)
                    db.flush()

                identity.ipfs_cid = existing.migrated_cid
                identity.display_name = payload.get("name") or identity.display_name
                identity.metadata_text = payload.get("metadata") or identity.metadata_text
                identity.profile_json = json.dumps(payload, ensure_ascii=False)
                migrated.append(
                    {
                        "address": identity.address,
                        "sourceValue": current_value,
                        "migratedCid": existing.migrated_cid,
                    }
                )

            db.commit()
            return {
                "success": True,
                "migratedCount": len(migrated),
                "skippedCount": len(skipped),
                "migrated": migrated,
                "skipped": skipped,
            }
        finally:
            db.close()

    def _process_block(self, db, block_num: int):
        block_hash = self.substrate.get_block_hash(block_num)
        block_timestamp = self._get_block_datetime(block_hash)
        extrinsic_hashes = self._get_extrinsic_hashes(block_hash)

        for event in self.substrate.get_events(block_hash):
            payload = event.value
            if payload.get("module_id") != "Contracts" or payload.get("event_id") != "ContractEmitted":
                continue

            attributes = payload.get("attributes", {})
            if attributes.get("contract") != CONTRACT_ADDRESS:
                continue

            decoded = self._decode_contract_event(
                data_hex=attributes.get("data"),
                topics=payload.get("topics", []),
            )
            if decoded is None:
                continue
            extrinsic_idx = payload.get("extrinsic_idx")
            extrinsic_hash = extrinsic_hashes.get(extrinsic_idx)
            self._apply_contract_event(
                db=db,
                decoded=decoded,
                block_number=block_num,
                block_timestamp=block_timestamp,
                extrinsic_hash=extrinsic_hash,
            )

    def _get_extrinsic_hashes(self, block_hash: str) -> dict[int, Optional[str]]:
        result = {}
        block = self.substrate.get_block(block_hash)
        for index, extrinsic in enumerate(block.get("extrinsics", [])):
            value = getattr(extrinsic, "value", extrinsic)
            result[index] = value.get("extrinsic_hash") if isinstance(value, dict) else None
        return result

    def _get_block_datetime(self, block_hash: str) -> datetime:
        try:
            timestamp = self.substrate.query("Timestamp", "Now", block_hash=block_hash).value
            if not timestamp:
                return datetime.utcnow()
            seconds = timestamp / 1000 if timestamp > 10_000_000_000 else timestamp
            return datetime.utcfromtimestamp(seconds)
        except Exception:
            return datetime.utcnow()

    def _decode_contract_event(self, data_hex: str, topics: list[str]) -> Optional[dict[str, Any]]:
        data = ScaleBytes(data_hex)
        topic_count = len(topics or [])

        if topic_count == 2:
            owner = self._decode_account_id(data)
            cid = self._decode_string(data)
            return {
                "name": "IdentityMinted",
                "args": {
                    "owner": owner,
                    "cid": cid,
                },
            }

        if topic_count == 3:
            from_address = self._decode_account_id(data)
            to_address = self._decode_account_id(data)
            relation_type = self._decode_u8(data)
            proof_hash = self._decode_h256(data)
            created_at = self._decode_u64(data)
            return {
                "name": "EndorsementCreated",
                "args": {
                    "from": from_address,
                    "to": to_address,
                    "relation_type": relation_type,
                    "proof_hash": proof_hash,
                    "created_at": created_at,
                },
            }

        return None

    def _decode_account_id(self, data: ScaleBytes) -> str:
        decoder = self.substrate.runtime_config.create_scale_object("AccountId", data=data)
        decoder.decode(check_remaining=False)
        value = str(decoder.value)
        if value.startswith("0x"):
            return ss58_encode(value.replace("0x", ""), ss58_format=self.substrate.ss58_format)
        return value

    def _decode_string(self, data: ScaleBytes) -> str:
        decoder = self.substrate.runtime_config.create_scale_object("String", data=data)
        decoder.decode(check_remaining=False)
        return str(decoder.value)

    def _decode_u8(self, data: ScaleBytes) -> int:
        decoder = self.substrate.runtime_config.create_scale_object("u8", data=data)
        decoder.decode(check_remaining=False)
        return int(decoder.value)

    def _decode_u64(self, data: ScaleBytes) -> int:
        decoder = self.substrate.runtime_config.create_scale_object("u64", data=data)
        decoder.decode(check_remaining=False)
        return int(decoder.value)

    def _decode_h256(self, data: ScaleBytes) -> str:
        decoder = self.substrate.runtime_config.create_scale_object("H256", data=data)
        decoder.decode(check_remaining=False)
        return str(decoder.value)

    def _apply_contract_event(
        self,
        db,
        decoded: dict[str, Any],
        block_number: int,
        block_timestamp: datetime,
        extrinsic_hash: Optional[str],
    ):
        event_name = decoded["name"]
        args = decoded["args"]

        if event_name == "IdentityMinted":
            self._upsert_identity(
                db=db,
                owner=str(args["owner"]),
                cid=str(args["cid"]),
                block_number=block_number,
                block_timestamp=block_timestamp,
                extrinsic_hash=extrinsic_hash,
            )
        elif event_name == "EndorsementCreated":
            relation_type = int(args["relation_type"])
            created_at_raw = int(args["created_at"])
            created_at = datetime.utcfromtimestamp(created_at_raw / 1000) if created_at_raw > 10_000_000_000 else datetime.utcfromtimestamp(created_at_raw)
            self._upsert_endorsement(
                db=db,
                from_address=str(args["from"]),
                to_address=str(args["to"]),
                relation_type=relation_type,
                proof_hash=str(args["proof_hash"]),
                created_at=created_at,
                block_number=block_number,
                extrinsic_hash=extrinsic_hash,
            )

    def _upsert_identity(
        self,
        db,
        owner: str,
        cid: str,
        block_number: int,
        block_timestamp: datetime,
        extrinsic_hash: Optional[str],
    ):
        profile_payload, stored_value = resolve_profile_payload(cid)
        identity = db.query(IndexedIdentity).filter(IndexedIdentity.address == owner).first()
        if identity is None:
            identity = IndexedIdentity(address=owner, ipfs_cid=stored_value)
            db.add(identity)

        migration = None
        if not is_probable_ipfs_cid(stored_value):
            migration = (
                db.query(IdentityIpfsMigration)
                .filter(
                    IdentityIpfsMigration.address == owner,
                    IdentityIpfsMigration.source_value == stored_value,
                )
                .first()
            )

        effective_cid = migration.migrated_cid if migration else stored_value
        effective_profile = profile_payload
        if migration and migration.profile_json:
            try:
                effective_profile = json.loads(migration.profile_json)
            except json.JSONDecodeError:
                effective_profile = profile_payload

        identity.ipfs_cid = effective_cid
        identity.display_name = _fix_double_encoded_utf8(effective_profile.get("name")) if effective_profile else None
        identity.metadata_text = _fix_double_encoded_utf8(effective_profile.get("metadata")) if effective_profile else None
        identity.profile_json = json.dumps(effective_profile, ensure_ascii=False) if effective_profile else None
        identity.registered_at = block_timestamp
        identity.block_number = block_number
        identity.extrinsic_hash = extrinsic_hash

    def _upsert_endorsement(
        self,
        db,
        from_address: str,
        to_address: str,
        relation_type: int,
        proof_hash: str,
        created_at: datetime,
        block_number: int,
        extrinsic_hash: Optional[str],
    ):
        endorsement = (
            db.query(IndexedEndorsement)
            .filter(
                IndexedEndorsement.from_address == from_address,
                IndexedEndorsement.to_address == to_address,
            )
            .first()
        )
        if endorsement is None:
            endorsement = IndexedEndorsement(from_address=from_address, to_address=to_address, relation_type=relation_type, relation_label=relation_label(relation_type), proof_hash=proof_hash, created_at=created_at, block_number=block_number)
            db.add(endorsement)
            db.flush()

            from_identity = db.query(IndexedIdentity).filter(IndexedIdentity.address == from_address).first()
            if from_identity is not None:
                from_identity.out_degree = (from_identity.out_degree or 0) + 1

            to_identity = db.query(IndexedIdentity).filter(IndexedIdentity.address == to_address).first()
            if to_identity is not None:
                to_identity.in_degree = (to_identity.in_degree or 0) + 1

        endorsement.relation_type = relation_type
        endorsement.relation_label = relation_label(relation_type)
        endorsement.proof_hash = proof_hash
        endorsement.created_at = created_at
        endorsement.block_number = block_number
        endorsement.extrinsic_hash = extrinsic_hash


_indexer_instance: Optional[ContractChainIndexer] = None


def get_indexer() -> ContractChainIndexer:
    global _indexer_instance
    if _indexer_instance is None:
        _indexer_instance = ContractChainIndexer()
    return _indexer_instance


if __name__ == "__main__":
    indexer = get_indexer()
    indexer.start()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        indexer.stop()
