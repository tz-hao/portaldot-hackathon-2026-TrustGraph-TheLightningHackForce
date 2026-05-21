#!/usr/bin/env bash
# ============================================================
# TrustGraph One-Click Startup Script
# Usage: bash start.sh [start|stop|status|restart]
# ============================================================
set -e

# Force UTF-8 to avoid Windows GBK encoding errors
export PYTHONIOENCODING=utf-8
export LANG=C.UTF-8 2>/dev/null || export LC_ALL=C.UTF-8 2>/dev/null || true

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# ---------- Config ----------
BACKEND_DIR="$SCRIPT_DIR/sovereign-graph-backend-python"
FRONTEND_DIR="$SCRIPT_DIR/frontend"
CONTRACT_DIR="$SCRIPT_DIR/trustgraph-contract"
PID_DIR="$SCRIPT_DIR/.trustgraph-testnet"
BACKEND_PORT="${BACKEND_PORT:-3000}"
FRONTEND_PORT="${FRONTEND_PORT:-8010}"
IPFS_API_PORT="${IPFS_API_PORT:-5001}"
CHAIN_WS_PORT="${CHAIN_WS_PORT:-9944}"

mkdir -p "$PID_DIR"

# ---------- Environment detection ----------
is_wsl()      { uname -r 2>/dev/null | grep -qi "microsoft\|wsl"; }
has_wsl_cmd() { command -v wsl >/dev/null 2>&1; }
is_windows()  { has_wsl_cmd || [[ -d /c/Windows ]]; }

# ---------- Helpers ----------
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${GREEN}[OK]${NC} $1"; }
warn()  { echo -e "${YELLOW}[--]${NC} $1"; }
err()   { echo -e "${RED}[ER]${NC} $1"; }
step()  { echo -e "\n${CYAN}--- $1 ---${NC}"; }

cleanup() {
    info "Stopping services..."

    # stop substrate node
    if has_wsl_cmd; then
        info "Stopping substrate-contracts-node in WSL..."
        wsl -e bash -c "export PATH=\$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin; pkill -f substrate-contracts-node" 2>/dev/null || true
    elif is_wsl; then
        info "Stopping substrate-contracts-node..."
        pkill -f substrate-contracts-node 2>/dev/null || true
    else
        pkill -f substrate-contracts-node 2>/dev/null || true
    fi

    for f in "$PID_DIR"/*.pid; do
        [ -f "$f" ] || continue
        local pid=$(cat "$f" 2>/dev/null)
        local name=$(basename "$f" .pid)
        [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && kill "$pid" 2>/dev/null && info "Stopped $name"
        rm -f "$f"
    done
    info "All services stopped"
}

# ---------- Command finders ----------
find_python() {
    command -v python3 2>/dev/null && { PYTHON=python3; return 0; }
    command -v python 2>/dev/null  && { PYTHON=python; return 0; }
    err "Python not found"; return 1
}

find_cargo() {
    command -v cargo 2>/dev/null && return 0
    # Windows paths (Git Bash)
    for d in "$HOME/.cargo/bin" "/c/Users/$USER/.cargo/bin" "$USERPROFILE/.cargo/bin"; do
        [ -x "$d/cargo" ] || [ -x "$d/cargo.exe" ] && { export PATH="$d:$PATH"; return 0; }
    done
    # WSL paths (when running from Git Bash, Cargo is often inside WSL)
    if has_wsl_cmd; then
        if wsl -e bash -c "export PATH=\$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin; command -v cargo" >/dev/null 2>&1; then
            # Cargo exists in WSL — we can use it via wsl for builds
            return 0
        fi
    fi
    return 1
}

find_ipfs() {
    command -v ipfs 2>/dev/null && return 0
    # Windows paths (Git Bash)
    for d in "/c/Program Files/IPFS/go-ipfs" "/d/IPFS/kubo" "$HOME/go-ipfs"; do
        [ -x "$d/ipfs" ] || [ -x "$d/ipfs.exe" ] && { export PATH="$d:$PATH"; return 0; }
    done
    # WSL paths (when running inside WSL, Windows IPFS might be reachable)
    for d in "/mnt/c/Program Files/IPFS/go-ipfs" "/mnt/d/IPFS/kubo" "/usr/local/bin"; do
        [ -x "$d/ipfs" ] || [ -x "$d/ipfs.exe" ] && { export PATH="$d:$PATH"; return 0; }
    done
    return 1
}

# ---------- Substrate chain startup ----------
start_chain() {
    local NODE_BIN=""

    # find the binary
    if has_wsl_cmd; then
        # Git Bash on Windows: chain runs in WSL
        NODE_BIN=$(wsl -e bash -c "export PATH=\$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin; command -v substrate-contracts-node 2>/dev/null || echo '\$HOME/.cargo/bin/substrate-contracts-node'" 2>/dev/null)
    elif is_wsl; then
        # Already inside WSL
        NODE_BIN=$(command -v substrate-contracts-node 2>/dev/null || echo "$HOME/.cargo/bin/substrate-contracts-node")
    else
        # Native Linux
        NODE_BIN=$(command -v substrate-contracts-node 2>/dev/null || echo "$HOME/.cargo/bin/substrate-contracts-node")
    fi

    # check if chain already reachable
    if curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$CHAIN_WS_PORT" 2>/dev/null | grep -qE '^[0-9]+$'; then
        info "Substrate chain already reachable on ws://127.0.0.1:$CHAIN_WS_PORT"
        return 0
    fi

    # check if process already running
    local chain_running=false
    if has_wsl_cmd; then
        wsl -e bash -c "export PATH=\$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin; pgrep -f substrate-contracts-node" >/dev/null 2>&1 && chain_running=true
    else
        pgrep -f substrate-contracts-node >/dev/null 2>&1 && chain_running=true
    fi

    if $chain_running; then
        info "substrate-contracts-node already running (waiting for port)..."
        for i in $(seq 1 15); do
            sleep 1
            if curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$CHAIN_WS_PORT" 2>/dev/null | grep -qE '^[0-9]+$'; then
                info "Substrate chain ready on ws://127.0.0.1:$CHAIN_WS_PORT"
                return 0
            fi
        done
        warn "Chain process running but port not open after 15s"
        return 1
    fi

    step "Starting substrate-contracts-node"

    if has_wsl_cmd; then
        info "Launching in WSL..."
        wsl -e bash -c "export PATH=\$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin; nohup $NODE_BIN --dev --unsafe-rpc-external --rpc-port $CHAIN_WS_PORT > /tmp/substrate-node.log 2>&1 &"
    elif is_wsl; then
        info "Launching directly (inside WSL)..."
        nohup "$NODE_BIN" --dev --unsafe-rpc-external --rpc-port "$CHAIN_WS_PORT" > /tmp/substrate-node.log 2>&1 &
        echo $! > "$PID_DIR/chain.pid"
    else
        info "Launching directly..."
        nohup "$NODE_BIN" --dev --rpc-port "$CHAIN_WS_PORT" > /tmp/substrate-node.log 2>&1 &
        echo $! > "$PID_DIR/chain.pid"
    fi

    info "Waiting for chain to boot (may take 15-30s)..."
    for i in $(seq 1 40); do
        sleep 1
        printf "."
        if curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$CHAIN_WS_PORT" 2>/dev/null | grep -qE '^[0-9]+$'; then
            echo ""
            info "Substrate chain ready on ws://127.0.0.1:$CHAIN_WS_PORT"
            return 0
        fi
    done
    echo ""
    warn "Substrate chain did not respond within 40s"
    return 1
}

# ---------- Status ----------
chain_status_label() {
    if curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$CHAIN_WS_PORT" 2>/dev/null | grep -qE '^[0-9]+$'; then
        echo -e "${GREEN}reachable${NC} (ws://127.0.0.1:$CHAIN_WS_PORT)"
    else
        echo -e "${RED}not reachable${NC}"
    fi
}

# ---------- Start ----------
cmd_start() {
    trap cleanup EXIT INT TERM
    step "TrustGraph Startup"

    # 1. Environment
    info "Checking environment..."
    if has_wsl_cmd; then  info "  Mode   : Windows (Git Bash) → WSL for chain"; fi
    if is_wsl; then       info "  Mode   : WSL (native chain)"; fi
    if ! has_wsl_cmd && ! is_wsl; then info "  Mode   : Native Linux"; fi

    find_python || exit 1
    info "  Python : $PYTHON"

    find_cargo && info "  Cargo  : found" || warn "  Cargo  : not found (skip contract build)"
    find_ipfs  && info "  IPFS   : found" || warn "  IPFS   : not found (skip IPFS daemon)"

    # 2. Substrate chain
    start_chain

    # 3. Contract build
    if [ -f "$CONTRACT_DIR/target/ink/trustgraph.contract" ]; then
        info "Contract artifacts exist, skip build"
    elif find_cargo; then
        step "Building contract"
        if has_wsl_cmd && ! command -v cargo >/dev/null 2>&1; then
            # Cargo only inside WSL — run build there
            local wsl_contract_dir=$(wsl wslpath -a "$CONTRACT_DIR" 2>/dev/null || echo "/mnt/c/Users/71546/Desktop/TrustGraph_Project/trustgraph-contract")
            wsl -e bash -c "export PATH=\$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin; cd '$wsl_contract_dir' && cargo contract build --release"
        else
            (cd "$CONTRACT_DIR" && cargo contract build --release)
        fi
        info "Contract build done"
    else
        warn "Skip contract build"
    fi

    # 4. IPFS daemon
    if find_ipfs; then
        if curl -s -X POST "http://127.0.0.1:$IPFS_API_PORT/api/v0/version" >/dev/null 2>&1; then
            info "IPFS daemon already running"
        else
            step "Starting IPFS daemon"
            ipfs daemon &
            echo $! > "$PID_DIR/ipfs.pid"
            sleep 3
            curl -s -X POST "http://127.0.0.1:$IPFS_API_PORT/api/v0/version" >/dev/null 2>&1 \
                && info "IPFS daemon started" \
                || warn "IPFS daemon failed to start"
        fi
    fi

    # 5. Backend
    step "Starting backend (port $BACKEND_PORT)"
    cd "$BACKEND_DIR"

    [ ! -d ".venv" ] && { info "Creating venv..."; $PYTHON -m venv .venv; }

    [ -f ".venv/Scripts/python.exe" ] && VENV_PY=".venv/Scripts/python.exe"
    [ -f ".venv/bin/python" ]        && VENV_PY=".venv/bin/python"
    [ -z "$VENV_PY" ]                && VENV_PY=".venv/bin/python3"

    info "Installing dependencies..."
    "$VENV_PY" -m pip install -q -r requirements.txt

    "$VENV_PY" -c "from database import init_db; init_db()" 2>/dev/null || true

    "$VENV_PY" main.py &
    echo $! > "$PID_DIR/backend.pid"
    sleep 2

    kill -0 "$(cat "$PID_DIR/backend.pid")" 2>/dev/null \
        && info "Backend: http://127.0.0.1:$BACKEND_PORT" \
        || { err "Backend failed to start"; exit 1; }

    # 6. Frontend
    step "Starting frontend (port $FRONTEND_PORT)"
    cd "$SCRIPT_DIR"
    $PYTHON -m http.server "$FRONTEND_PORT" --bind 127.0.0.1 &
    echo $! > "$PID_DIR/frontend.pid"
    sleep 1
    info "Frontend: http://127.0.0.1:$FRONTEND_PORT/frontend/sovereigngraph-realnet.html"
    cd "$SCRIPT_DIR"

    # 7. Summary
    echo ""
    echo -e "${CYAN}+----------------------------------------------------+${NC}"
    echo -e "${CYAN}|${NC}   ${GREEN}TrustGraph Ready${NC}                                   ${CYAN}|${NC}"
    echo -e "${CYAN}|${NC}  Chain    : ws://127.0.0.1:$CHAIN_WS_PORT                          ${CYAN}|${NC}"
    echo -e "${CYAN}|${NC}  Backend  : http://127.0.0.1:$BACKEND_PORT                         ${CYAN}|${NC}"
    echo -e "${CYAN}|${NC}  Frontend : http://127.0.0.1:$FRONTEND_PORT/frontend/sovereigngraph-realnet.html${CYAN}|${NC}"
    echo -e "${CYAN}|${NC}  GraphQL  : http://127.0.0.1:$BACKEND_PORT/graphql                 ${CYAN}|${NC}"
    echo -e "${CYAN}+----------------------------------------------------+${NC}"
    echo ""
    info "Press Ctrl+C to stop all services"
    wait
}

# ---------- Stop ----------
cmd_stop() { cleanup; }

# ---------- Status ----------
cmd_status() {
    echo "TrustGraph Service Status"
    echo "-------------------------"

    echo -n "Substrate chain: "
    chain_status_label

    for f in "$PID_DIR"/*.pid; do
        [ -f "$f" ] || continue
        local pid=$(cat "$f" 2>/dev/null)
        local name=$(basename "$f" .pid)
        [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null \
            && info "$name: running (PID $pid)" \
            || warn "$name: not running"
    done
    echo ""
    echo "Ports:"
    for p in $CHAIN_WS_PORT $BACKEND_PORT $FRONTEND_PORT; do
        if curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$p" 2>/dev/null | grep -qE '^[0-9]+$'; then
            info ":$p listening"
        else
            warn ":$p not listening"
        fi
    done
}

# ---------- Entry ----------
case "${1:-start}" in
    start)   cmd_start ;;
    stop)    cmd_stop ;;
    status)  cmd_status ;;
    restart) cmd_stop; sleep 1; cmd_start ;;
    *)       echo "Usage: bash start.sh [start|stop|status|restart]"; exit 1 ;;
esac
