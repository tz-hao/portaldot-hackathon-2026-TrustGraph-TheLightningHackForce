import json
import subprocess
import sys
from pathlib import Path

from substrateinterface import Keypair, SubstrateInterface
from substrateinterface.contracts import ContractCode


NODE_URL = "ws://127.0.0.1:9944"
ENDOWMENT = 10**15
GAS_LIMIT = {"ref_time": 1_000_000_000_000, "proof_size": 262_144}


def build_constructor_args(metadata_path: Path) -> dict:
    with metadata_path.open("r", encoding="utf-8") as handle:
        metadata = json.load(handle)

    spec = metadata.get("spec", {})
    constructors = spec.get("constructors", [])

    new_constructor = next(
        (constructor for constructor in constructors if constructor.get("label") == "new"),
        None,
    )
    if new_constructor is None:
        raise RuntimeError("Metadata 中未找到 `new` 构造函数")

    args = new_constructor.get("args", [])
    if args:
        labels = [arg.get("label") for arg in args]
        raise RuntimeError(
            "`new` 构造函数当前应为无参，但 metadata 中仍包含参数: "
            + ", ".join(str(label) for label in labels)
        )

    return {}


def ensure_contract_artifacts(project_root: Path) -> tuple[Path, Path, Path]:
    wasm_path = project_root / "target" / "ink" / "trustgraph.wasm"
    metadata_path = project_root / "target" / "ink" / "trustgraph.json"
    bundle_path = project_root / "target" / "ink" / "trustgraph.contract"

    if wasm_path.exists() and metadata_path.exists() and bundle_path.exists():
        return wasm_path, metadata_path, bundle_path

    print("Contract artifacts are incomplete, building with `cargo contract build --release` ...", flush=True)
    subprocess.run(
        ["cargo", "contract", "build", "--release"],
        cwd=project_root,
        check=True,
    )

    if not wasm_path.exists():
        raise RuntimeError(f"构建完成后仍未找到 Wasm 文件: {wasm_path}")

    if not metadata_path.exists():
        raise RuntimeError(f"构建完成后仍未找到 Metadata 文件: {metadata_path}")

    if not bundle_path.exists():
        raise RuntimeError(f"构建完成后仍未找到 .contract 文件: {bundle_path}")

    return wasm_path, metadata_path, bundle_path


def get_call_arg_names(call_function) -> list[str]:
    arg_names = []

    for arg in getattr(call_function, "args", []) or []:
        if isinstance(arg, dict) and "name" in arg:
            arg_names.append(arg["name"])
            continue

        name = getattr(arg, "name", None)
        if name is not None:
            arg_names.append(name)
            continue

        value = getattr(arg, "value", None)
        if isinstance(value, dict) and "name" in value:
            arg_names.append(value["name"])

    return arg_names


def deploy_contract(code: ContractCode, keypair: Keypair, constructor_args: dict) -> str:
    constructor_data = code.metadata.generate_constructor_data(name="new", args=constructor_args)

    call_function = code.substrate.get_metadata_call_function("Contracts", "instantiate_with_code")
    if call_function is None:
        raise RuntimeError("当前节点不支持 `Contracts.instantiate_with_code`")

    call_params = {
        "gas_limit": GAS_LIMIT,
        "code": f"0x{code.wasm_bytes.hex()}",
        "data": constructor_data.to_hex(),
        "salt": "",
    }

    call_arg_names = set(get_call_arg_names(call_function))

    if "value" in call_arg_names:
        call_params["value"] = ENDOWMENT
    elif "endowment" in call_arg_names:
        call_params["endowment"] = ENDOWMENT
    else:
        raise RuntimeError("节点的 `instantiate_with_code` 既不包含 `value` 也不包含 `endowment` 参数")

    if "storage_deposit_limit" in call_arg_names:
        call_params["storage_deposit_limit"] = None

    try:
        call = code.substrate.compose_call(
            call_module="Contracts",
            call_function=call_function.name,
            call_params=call_params,
        )
    except TypeError as exc:
        if "int()" not in str(exc):
            raise

        fallback_params = dict(call_params)
        fallback_params["gas_limit"] = GAS_LIMIT["ref_time"]
        call = code.substrate.compose_call(
            call_module="Contracts",
            call_function=call_function.name,
            call_params=fallback_params,
        )

    extrinsic = code.substrate.create_signed_extrinsic(call=call, keypair=keypair)
    result = code.substrate.submit_extrinsic(extrinsic, wait_for_inclusion=True)

    if not result.is_success:
        raise RuntimeError(result.error_message)

    for event in result.triggered_events:
        if code.substrate.implements_scaleinfo():
            event_value = event.value["event"]
            if event_value["event_id"] == "Instantiated":
                attributes = event_value["attributes"]
                if isinstance(attributes, dict):
                    return attributes["contract"]
                return attributes[1]
        else:
            if event.event.name == "Instantiated":
                return event.params[1]["value"]

    raise RuntimeError("部署交易已上链，但未在事件中找到 Instantiated 合约地址")


def deployment_hint(bundle_path: Path) -> str:
    return (
        "请确认本地节点已启动，并优先使用与当前 ink! metadata 兼容的 Contracts UI。"
        f"如需手动部署，可在 UI 中上传 `{bundle_path.name}`，或使用 `cargo contract instantiate`。"
    )


def main() -> int:
    project_root = Path(__file__).resolve().parent
    wasm_path, metadata_path, bundle_path = ensure_contract_artifacts(project_root)

    constructor_args = build_constructor_args(metadata_path)

    print(f"Connecting to {NODE_URL} ...", flush=True)
    substrate = SubstrateInterface(url=NODE_URL, type_registry_preset="canvas")
    keypair = Keypair.create_from_uri("//Alice")

    print("Loading contract artifacts ...", flush=True)
    code = ContractCode.create_from_contract_files(
        metadata_file=str(metadata_path),
        wasm_file=str(wasm_path),
        substrate=substrate,
    )

    print("Deploying contract ...", flush=True)
    try:
        contract_address = deploy_contract(code, keypair, constructor_args)
    except Exception as exc:
        raise RuntimeError(f"{exc}\n{deployment_hint(bundle_path)}") from exc

    print(f"Contract Address: {contract_address}", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"部署失败: {exc}", file=sys.stderr)
        raise SystemExit(1)
