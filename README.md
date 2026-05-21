# TrustGraph — On-Chain Trust Network with IPFS-Anchored Identity

## Project Overview

### Problem Statement

In Web3 ecosystems, trust relationships between identities (humans, DAOs, AI agents) are fragmented across platforms and lack verifiable on-chain provenance. Existing DID solutions focus on self-sovereign identity issuance but stop short of mapping the **dynamic trust graph** between entities — who endorsed whom, who collaborated with whom, and under what semantic context. Without a composable, queryable trust graph, reputation remains siloed and non-transferable across dApps.

### Solution

TrustGraph is a **local-first SovereignGraph** that mints on-chain identity SBTs (Soulbound Tokens) and records cryptographically-verifiable relationship edges on a Substrate contracts chain. It provides:

- **On-chain identity registration**: one identity per wallet, pinned to an IPFS CID containing a rich profile (name, metadata, roles)
- **Semantic relationship edges**: `COLLABORATION`, `ENDORSEMENT`, `CONTRIBUTION` with proof hashes stored on-chain for future ZK verification
- **Real-time trust graph visualization**: a force-directed knowledge graph rendered in the browser, updated live from chain events via a Python indexer and GraphQL API
- **Dual-mode operation**: Mock mode for instant demo preview without a chain; RealNet mode for full Polkadot.js wallet + live contract interaction

### Blockchain Relevance

- **Smart Contracts**: ink! 5.1.1 (Rust) on Substrate contracts pallet — on-chain identity SBT registry + endorsement proof storage
- **DID / Reputation**: Non-transferable identity profiles + directed trust edges form a verifiable Web3 reputation graph
- **IPFS**: Off-chain profile data anchored by CID stored on-chain, enabling rich metadata without bloating contract storage
- **Indexer + GraphQL**: Subsquid-inspired Python chain indexer decodes SCALE-encoded contract events into a queryable SQLite knowledge graph
- **Frontend**: Polkadot.js browser extension integration for transaction signing; AntV G6 for interactive graph visualization

### Hackathon Track Alignment — Portaldot Native Application

TrustGraph is built for the **"Build practical on-chain applications natively on Portaldot"** track. Every design decision reflects its requirements:

| Track Requirement | How TrustGraph Delivers |
|---|---|
| **Native Portaldot architecture** | ink! 5.1.1 (Rust) smart contract on Substrate `pallet-contracts`. Zero EVM dependencies. Uses `substrate-interface` (Python) and `polkadot.js` — the native Substrate toolchain, not Ethereum libraries. |
| **Practical, user-facing product** | A browser-based DApp where real users connect a wallet, register an identity, and create endorsement relationships. Not a protocol, not infrastructure — a product with a UI. |
| **Real on-chain logic** | Every identity and every trust relationship is a contract state change. `register_identity` mints an SBT-like profile. `endorse` stores a cryptographically-hashed proof on-chain. Both emit events consumed by the indexer. |
| **Runnable MVP** | `bash start.sh start` — one command boots the full stack. Mock mode provides an instant demo without a chain. RealNet mode connects Polkadot.js for live transactions. |
| **Complete end-to-end demo** | User journey: open DApp → connect wallet → register on-chain identity → upload profile to IPFS → create endorsement edges → explore the live trust graph → semantic search. Every step is functional. |
| **Clean user scenario** | A Web3 community needs to know **who trusts whom, and why**. TrustGraph gives them a visible, queryable, on-chain trust network — useful for DAO contributor vetting, AI agent reputation, and cross-community credibility. |

---

## Technical Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Browser DApp (Vue 2.7 + G6)           │
│  Polkadot.js ext ──> sign tx ──> ink! contract           │
│  GraphQL client  ──> query ──> FastAPI backend            │
└──────────────────────────────────────────────────────────┘
         │                              │
         │ tx signing                   │ data query
         ▼                              ▼
┌──────────────────┐    ┌──────────────────────────────────┐
│ Substrate Node   │    │  Python Backend (FastAPI)          │
│ contracts pallet │    │  ┌────────────┐ ┌──────────────┐ │
│  ┌─────────────┐ │    │  │ Chain      │ │ Strawberry   │ │
│  │ TrustGraph  │ │    │  │ Indexer    │ │ GraphQL      │ │
│  │ ink! contract│◄─────┤  │ (SCALE     │ │ Schema       │ │
│  │             │ │events│  │  decode)   │ │              │ │
│  └─────────────┘ │    │  └─────┬──────┘ └──────┬───────┘ │
└──────────────────┘    │        │               │         │
                        │        ▼               │         │
┌──────────┐            │  ┌──────────┐          │         │
│  IPFS    │◄──CID──────┤  │ SQLite   │◄─────────┘         │
│  Kubo    │            │  │ DB       │                     │
└──────────┘            │  └──────────┘                     │
                        └──────────────────────────────────┘
```

### Core Tech Stack

| Layer | Technology |
|-------|-----------|
| Blockchain | Substrate Contracts Node (pallet-contracts) |
| Smart Contract | ink! 5.1.1 (Rust), parity-scale-codec 3 |
| Backend | Python 3, FastAPI, Strawberry GraphQL, SQLAlchemy, substrate-interface |
| Frontend | Vue 2.7 (CDN), AntV G6 4.8, Polkadot.js API |
| Data Storage | IPFS (Kubo), SQLite |
| Wallet | Polkadot.js Browser Extension |

---

## Smart Contracts

### Contract File Directory

```
trustgraph-contract/
├── Cargo.toml              # ink! 5.1.1, scale-codec, scale-info
├── rust-toolchain.toml     # Rust 1.89.0, wasm32-unknown-unknown
├── trustgraph.rs           # Main contract (380 LOC, 9 unit tests)
├── deploy.py               # Python deployment script
└── target/ink/
    ├── trustgraph.wasm     # Compiled WASM (9 KB)
    ├── trustgraph.json     # Contract ABI / metadata (24 KB)
    └── trustgraph.contract # Bundled artifact (28 KB)
```

### Key Contract Messages

| Message | Signature | Description |
|---------|-----------|-------------|
| `register_identity` | `(cid: String) -> Result<()>` | Mint an on-chain identity SBT pinned to an IPFS CID. Fails if caller already registered. |
| `get_profile` | `(owner: AccountId) -> Option<Profile>` | Retrieve the `{ ipfs_cid }` profile for a given account. |
| `is_registered` | `(owner: AccountId) -> bool` | Check whether an address has a registered identity. |
| `endorse` | `(target: AccountId, relation_type: u8, proof_hash: Hash) -> Result<()>` | Create a directed trust edge. Rejects self-endorsement, unregistered source/target, and duplicate edges. |
| `get_endorsement` | `(from: AccountId, to: AccountId) -> Option<Endorsement>` | Query the `{ relation_type, proof_hash, created_at }` endorsement between two addresses. |
| `get_identity_count` | `() -> u64` | Total number of registered identities. |
| `get_identity_by_index` | `(index: u64) -> Option<AccountId>` | Enumerate registered addresses (0-based). |

**Events**: `IdentityMinted(owner, cid)`, `EndorsementCreated(from, to, relation_type, proof_hash, created_at)`

**Relation Types**: `0 = COLLABORATION`, `1 = ENDORSEMENT`, `2 = CONTRIBUTION`

**Error Codes**: `AlreadyRegistered`, `IdentityNotRegistered`, `TargetNotRegistered`, `SelfEndorsement`, `AlreadyEndorsed`

### Deployment Instructions

```bash
# 1. Start local Substrate contracts node (in WSL on Windows)
#    On Linux/macOS: substrate-contracts-node --dev
wsl bash -c "nohup ~/.cargo/bin/substrate-contracts-node --dev --unsafe-rpc-external --rpc-port 9944 > /tmp/substrate-node.log 2>&1 &"

# 2. Build contract
cd trustgraph-contract
cargo contract build --release

# 3. Deploy using Python script (or cargo contract)
python deploy.py
# OR
cargo contract instantiate --suri //Alice --constructor new --args
```

Deployed address (dev chain): `5CqYubyHiCH2bYmTfeLCcLhtBbMJCDHfmHdZWdDd1a5xqUme`

---

## Installation & Setup

### Requirements

- **Node.js** ≥ 18 (for `cargo contract` tooling)
- **Rust** 1.89+ with `wasm32-unknown-unknown` target
- **Python** 3.10+
- **IPFS** (Kubo) ≥ 0.40.0
- **substrate-contracts-node** (Substrate with pallet-contracts, runs in WSL on Windows)
- **WSL** (Windows Subsystem for Linux, required on Windows for the Substrate node)
- **Polkadot.js Browser Extension** (for RealNet mode)

### Quick Start (One Command)

```bash
git clone <repo-url>
cd TrustGraph_Project
bash start.sh start
```

This single command: starts the Substrate contracts node in WSL (auto-detected), builds the contract if needed, starts IPFS daemon, launches the Python backend (auto-creates venv), and serves the frontend.

> **Windows users**: The Substrate node runs inside WSL. Ensure WSL is installed and `substrate-contracts-node` is available at `~/.cargo/bin/substrate-contracts-node` in your WSL environment. The script uses `wsl` command to start/stop it automatically.

### Manual Setup

```bash
# 0. Start Substrate chain (in WSL on Windows)
wsl bash -c "nohup ~/.cargo/bin/substrate-contracts-node --dev --unsafe-rpc-external --rpc-port 9944 > /tmp/substrate-node.log 2>&1 &"

# 1. Compile smart contract
cd trustgraph-contract
cargo contract build --release

# 2. Start IPFS daemon
ipfs daemon &

# 3. Setup backend
cd sovereign-graph-backend-python
python -m venv .venv
source .venv/bin/activate  # or .venv\Scripts\activate on Windows
pip install -r requirements.txt
cp .env.example .env  # edit RPC_ENDPOINT, CONTRACT_ADDRESS as needed
python main.py &

# 4. Serve frontend
cd ..
python -m http.server 8010 &
```

> **Note**: On Windows, the Substrate node runs inside WSL. Omit step 0 if running natively on Linux/macOS — use `substrate-contracts-node --dev` directly.

### Access Points

| Service | URL |
|---------|-----|
| Frontend DApp | http://127.0.0.1:8010/frontend/sovereigngraph-realnet.html |
| Backend API | http://127.0.0.1:3000 |
| GraphQL Playground | http://127.0.0.1:3000/graphql |
| IPFS API | http://127.0.0.1:5001 |
| Substrate RPC | ws://127.0.0.1:9944 |

---

## Demo

### Live Demo

Open http://127.0.0.1:8010/frontend/sovereigngraph-realnet.html in a browser with Polkadot.js extension installed.

**Mock Mode** (default, no wallet needed): Pre-loaded with 3 demo identities (Portaldot Foundation, BuilderDAO, Alice Dev) and 2 relationship edges. Explore the trust graph, search nodes by keyword, and drag/zoom the canvas.

**RealNet Mode**: Connect Polkadot.js wallet → register an on-chain identity with IPFS profile → create endorsement relationships → graph updates in real-time via chain indexer.

### Test Accounts (Dev Chain)

| Account | Address |
|---------|---------|
| Alice   | `5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY` |
| Bob     | `5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty` |

Use Polkadot.js extension with these pre-funded dev accounts, or import them via the "Add Account" flow.

### Video Link

*[Add demo video URL here]*

---

## Roadmap

### Completed Features

- [x] ink! smart contract: identity registration + endorsement edges with proof hashes
- [x] 9 unit tests covering all contract messages and error conditions
- [x] Python chain indexer with SCALE event decoding and SQLite persistence
- [x] Strawberry GraphQL API for knowledge graph querying
- [x] IPFS profile upload bridge with CID anchoring
- [x] Interactive G6 force-directed trust graph with drag, zoom, hover tooltips
- [x] Semantic keyword search + highlight across nodes and relationships
- [x] Polkadot.js wallet integration for transaction signing
- [x] Dual mock/realnet modes
- [x] One-click `start.sh` script with WSL chain auto-start
- [x] Wallet-centric tree layout with center-node pinning

### Next Phase Plans

- [ ] ZK proof verification for relationship edges (BabyJubJub or similar)
- [ ] Subsquid-based indexer for production-scale event processing
- [ ] Multi-chain trust graph aggregation (EVM ↔ Substrate bridges)
- [ ] Decentralized IPFS pinning via Filecoin / Crust Network
- [ ] Reputation scoring algorithm based on graph topology (PageRank, EigenTrust)
- [ ] DAO governance integration for community-endorsed identity verification
- [ ] Mobile-friendly responsive UI

---

## Team

**Team Name**: TrustGraph — The Lightning Hack Force

| Name | Role |
|------|------|
| Miles | Smart Contract Developer |
| fang | Backend Developer |
| Jaspero | Frontend Developer |
| Danny | Frontend Developer |

**Contact**: Telegram [@Miles7899](https://t.me/Miles7899) (for hackathon communication only)

---

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
