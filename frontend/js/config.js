// SovereignGraph 前端配置 & 共享常量
// 页面需要通过 http 服务打开，以便读取本地 metadata JSON。

window.CONTRACT_CONFIG = {
    contractAddress: "5CqYubyHiCH2bYmTfeLCcLhtBbMJCDHfmHdZWdDd1a5xqUme",
    metadataUrl: "../trustgraph-contract/target/ink/trustgraph.json",
    rpcUrls: ["ws://127.0.0.1:9944", "ws://192.168.43.4:9944"],
    backendBaseUrl: "http://127.0.0.1:3000",
    localGraphApiUrl: "http://127.0.0.1:3000/graphql",
    localSyncApiUrl: "http://127.0.0.1:3000/sync-now",
    ipfsUploadUrl: "http://127.0.0.1:3000/ipfs/upload",
    ipfsMigrateUrl: "http://127.0.0.1:3000/ipfs/migrate-inline-identities",
    defaultProofHash: "0x0909090909090909090909090909090909090909090909090909090909090909",
    knownAccounts: [
        { address: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY", label: "Alice" },
        { address: "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty", label: "Bob" }
    ]
};

// toast 定时器句柄（跨方法共享）
window._toastTimer = null;
