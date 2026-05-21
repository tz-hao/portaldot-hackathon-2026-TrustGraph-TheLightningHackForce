import json
import logging
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncGenerator

import uvicorn
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy.orm import Session
from strawberry.fastapi import GraphQLRouter

from database import IndexedEndorsement, IndexedIdentity, get_db
from graphql_schema import schema
from indexer import get_indexer, ipfs_is_available, upload_json_to_ipfs

# Force UTF-8 encoding on Windows to avoid GBK garbled output
if sys.platform == "win32":
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("sovereigngraph")

RPC_URL = os.getenv("RPC_URL", os.getenv("RPC_ENDPOINT", "ws://127.0.0.1:9944"))
CONTRACT_ADDRESS = os.getenv(
    "CONTRACT_ADDRESS",
    "5CqYubyHiCH2bYmTfeLCcLhtBbMJCDHfmHdZWdDd1a5xqUme",
)


def _validate_startup():
    """Startup connectivity check: chain RPC, IPFS, contract metadata."""
    issues = []

    # 1. Chain RPC reachable
    try:
        indexer = get_indexer()
        indexer.ensure_ready()
        block = indexer.substrate.get_block_number(None)
        logger.info("Chain RPC OK — current block: %s", block)
    except (ConnectionRefusedError, OSError) as exc:
        issues.append(f"Chain RPC ({RPC_URL}): connection refused — is the substrate node running?")
    except Exception as exc:
        issues.append(f"Chain RPC ({RPC_URL}): {exc}")

    # 2. IPFS daemon reachable
    if ipfs_is_available():
        logger.info("IPFS daemon OK")
    else:
        issues.append("IPFS daemon unreachable (http://127.0.0.1:5001)")

    # 3. Contract metadata file exists
    metadata_path = Path(
        os.getenv(
            "CONTRACT_METADATA_PATH",
            str(Path(__file__).resolve().parents[1] / "trustgraph-contract" / "target" / "ink" / "trustgraph.json"),
        )
    )
    if not metadata_path.exists():
        issues.append(f"Contract metadata not found: {metadata_path}")

    if issues:
        logger.warning("Startup validation issues: %s", "; ".join(issues))
    else:
        logger.info("Startup validation passed")

    return issues


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    _validate_startup()

    indexer = get_indexer()
    indexer.start()
    try:
        indexer.recompute_degrees()
    except Exception:
        pass
    yield
    indexer.stop()


app = FastAPI(lifespan=lifespan)
indexer = get_indexer()

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# strawberry GraphQL endpoint
graphql_app = GraphQLRouter(schema, path="/graphql")
app.include_router(graphql_app)


@app.get("/")
async def root():
    return {
        "message": "SovereignGraph Backend",
        "graphql_endpoint": "/graphql",
        "status_endpoint": "/status",
        "sync_endpoint": "/sync-now",
        "ipfs_upload_endpoint": "/ipfs/upload",
    }


class IdentityInput(BaseModel):
    address: str
    ipfs_cid: str


class EndorsementInput(BaseModel):
    from_address: str
    to_address: str
    relation_type: int = 1
    proof_hash: str = "0xmanual"


class ProfileUploadInput(BaseModel):
    name: str
    metadata: str = ""


@app.get("/status")
async def status():
    return indexer.get_status()


@app.post("/sync-now")
async def sync_now():
    try:
        indexer.sync_once()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Indexer sync failed: {exc}") from exc
    return {"success": True, "status": indexer.get_status()}


@app.post("/ipfs/upload")
async def ipfs_upload(payload: ProfileUploadInput):
    try:
        result = upload_json_to_ipfs(
            {
                "name": payload.name.strip(),
                "metadata": payload.metadata.strip(),
            }
        )
        return {"success": True, **result}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"IPFS upload failed: {exc}") from exc


@app.post("/ipfs/migrate-inline-identities")
async def migrate_inline_identities():
    try:
        result = indexer.migrate_inline_identities_to_ipfs()
        report_path = Path(__file__).resolve().with_name("ipfs_migration_report.json")
        report_path.write_text(
            json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return {
            **result,
            "reportPath": str(report_path),
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"IPFS migration failed: {exc}") from exc


@app.post("/add_identity")
async def add_identity(data: IdentityInput, db: Session = Depends(get_db)):
    existing = db.query(IndexedIdentity).filter(IndexedIdentity.address == data.address).first()
    if not existing:
        identity = IndexedIdentity(
            address=data.address,
            ipfs_cid=data.ipfs_cid,
            display_name=data.address[:8],
            metadata_text="manual import",
            block_number=0,
        )
        db.add(identity)
        db.commit()
        return {"success": True, "message": "Identity added"}
    else:
        return {"success": True, "message": "Identity already exists"}


@app.post("/add_endorsement")
async def add_endorsement(data: EndorsementInput, db: Session = Depends(get_db)):
    endorsement = IndexedEndorsement(
        from_address=data.from_address,
        to_address=data.to_address,
        relation_type=data.relation_type,
        relation_label={0: "COLLABORATION", 1: "ENDORSEMENT", 2: "CONTRIBUTION"}.get(
            data.relation_type, "ENDORSEMENT"
        ),
        proof_hash=data.proof_hash,
        block_number=0,
    )
    db.add(endorsement)
    db.commit()
    return {"success": True, "message": "Endorsement added"}


@app.post("/clear_data")
async def clear_data():
    try:
        indexer.reset()
        return {"success": True, "message": "All data cleared"}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Clear data failed: {exc}") from exc


# ======================================

if __name__ == "__main__":
    port = int(os.getenv("PORT", 3000))
    uvicorn.run(app, host="0.0.0.0", port=port)
