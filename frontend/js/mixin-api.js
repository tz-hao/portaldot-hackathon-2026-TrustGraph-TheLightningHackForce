// SovereignGraph mixin_api – Vue 2 mixin
window.mixin_api = {
    methods: {
        // fetchSystemStatus
        async fetchSystemStatus(showToast = false) {
                try {
                    const response = await axios.get(`${window.CONTRACT_CONFIG.backendBaseUrl}/status`, { timeout: 5000 });
                    const data = response.data || {};
                    this.healthStatus = {
                        chain: {
                            state: data.chainAvailable ? 'ok' : 'error',
                            label: data.chainAvailable ? '在线' : '离线'
                        },
                        indexer: {
                            state: data.indexerHealthy ? 'ok' : 'error',
                            label: data.indexerHealthy ? '运行中' : '异常'
                        },
                        ipfs: {
                            state: data.ipfsAvailable ? 'ok' : 'error',
                            label: data.ipfsAvailable ? '在线' : '离线'
                        },
                        contract: {
                            state: (data.contractAddress && this.contractReady) ? 'ok' : (data.contractAddress ? 'pending' : 'error'),
                            label: (data.contractAddress && this.contractReady) ? '已连接' : (data.contractAddress ? '待连接' : '未配置')
                        },
                        rpcUrl: data.rpcUrl || '',
                        lastProcessedBlock: data.lastProcessedBlock,
                        currentBlock: data.currentBlock,
                        lastError: data.lastError || ''
                    };
                    if (showToast) {
                        this.showToast('系统状态已刷新');
                    }
                } catch (err) {
                    const msg = (err?.message || String(err)).toLowerCase();
                    const isConnRefused = msg.includes('connection refused') || msg.includes('actively refused')
                        || msg.includes('目标计算机积极拒绝') || msg.includes('10061')
                        || msg.includes('failed to establish a new connection')
                        || msg.includes('timeout') || msg.includes('aborted')
                        || msg.includes('network error') || msg.includes('err_aborted');
                    const friendly = isConnRefused
                        ? 'Backend unreachable (port 3000) — run: bash start.sh start'
                        : (err?.message || 'Backend unreachable');
                    this.healthStatus = {
                        chain: { state: 'error', label: '后端不可达' },
                        indexer: { state: 'error', label: '后端不可达' },
                        ipfs: { state: 'error', label: '后端不可达' },
                        contract: { state: this.contractReady ? 'ok' : 'pending', label: this.contractReady ? '已连接' : '未检测' },
                        rpcUrl: '',
                        lastProcessedBlock: null,
                        currentBlock: null,
                        lastError: friendly
                    };
                    if (showToast) {
                        this.showToast('Backend unreachable — check that the backend is running on port ' + window.CONTRACT_CONFIG.backendBaseUrl);
                    }
                }
            },
        // dismissMigrationResult
        dismissMigrationResult() {
                this.lastMigration = null;
            },
        // runIpfsMigration
        async runIpfsMigration() {
                if (this.migrationRunning) return;
                this.migrationRunning = true;
                try {
                    const response = await axios.post(window.CONTRACT_CONFIG.ipfsMigrateUrl, {}, { timeout: 30000 });
                    this.lastMigration = response.data || null;
                    this.addLog(`🗂️ 已完成 IPFS 迁移: ${this.lastMigration?.migratedCount || 0} 条`);
                    await this.fetchSystemStatus();
                    await this.refreshFromIndexer();
                    this.showToast(`IPFS 迁移完成: ${this.lastMigration?.migratedCount || 0} 条`);
                } catch (err) {
                    const detail = err?.response?.data?.detail || err?.message || 'IPFS 迁移失败';
                    this.showToast(`IPFS 迁移失败: ${detail}`, 5000);
                } finally {
                    this.migrationRunning = false;
                }
            },
        // requestIndexerSync
        async requestIndexerSync() {
                try {
                    await axios.post(window.CONTRACT_CONFIG.localSyncApiUrl);
                } catch (err) {
                    console.warn('indexer sync failed', err);
                }
            },
        // buildGraphFromApi
        async buildGraphFromApi() {
                const query = `
                    query TrustGraphView {
                        knowledgeGraph {
                            nodes {
                                address
                                ipfsCid
                                name
                                metadata
                                registeredAt
                            }
                            edges {
                                fromAddress
                                toAddress
                                relationType
                                relationLabel
                                proofHash
                                createdAt
                            }
                        }
                    }
                `;
                const response = await axios.post(window.CONTRACT_CONFIG.localGraphApiUrl, { query });
                const graph = response?.data?.data?.knowledgeGraph;
                if (!graph) {
                    throw new Error('GraphQL 未返回 knowledgeGraph');
                }

                return {
                    nodes: (graph.nodes || []).map(node => ({
                        id: node.address,
                        name: node.name || this.shortenAddress(node.address),
                        metadata: node.metadata || node.ipfsCid || '',
                        ipfsCid: node.ipfsCid || '',
                        type: 'user',
                        owner: node.address
                    })),
                    edges: (graph.edges || []).map(edge => ({
                        from: edge.fromAddress,
                        to: edge.toAddress,
                        relationship: edge.relationLabel || this.relationshipTypeLabel(Number(edge.relationType ?? 1)),
                        proofHash: edge.proofHash || '',
                        createdAt: edge.createdAt || ''
                    }))
                };
            },
        // buildGraphFromChain
        async buildGraphFromChain() {
                const caller = this.account?.address || window.CONTRACT_CONFIG.knownAccounts[0].address;
                const nodes = [];
                const registeredAddresses = [];

                // 优先通过 get_identity_count / get_identity_by_index 枚举所有身份
                try {
                    const countResult = await this.contractQuery('get_identity_count', caller, []);
                    const total = Number(countResult ?? 0);
                    for (let i = 0; i < total && i < 200; i++) {
                        try {
                            const addr = await this.contractQuery('get_identity_by_index', caller, [i]);
                            if (!addr) continue;
                            const address = String(addr);
                            const profile = await this.contractQuery('get_profile', caller, [address]);
                            if (!profile) continue;
                            const cid = profile.ipfsCid || profile.ipfs_cid || '';
                            const parsed = this.parseProfileCid(cid, address);
                            nodes.push({
                                id: address,
                                name: parsed.name,
                                metadata: parsed.metadata || cid,
                                ipfsCid: cid,
                                type: 'user',
                                owner: address
                            });
                            registeredAddresses.push(address);
                        } catch (err) {
                            console.warn('query by index failed', i, err);
                        }
                    }
                } catch (err) {
                    console.warn('identity enumeration failed, falling back to known accounts', err);
                }

                // 降级：如果枚举失败，回退到已知地址列表
                if (registeredAddresses.length === 0) {
                    const addresses = this.getKnownAccounts();
                    for (const address of addresses) {
                        try {
                            const profile = await this.contractQuery('get_profile', caller, [address]);
                            if (!profile) continue;
                            const cid = profile.ipfsCid || profile.ipfs_cid || '';
                            const parsed = this.parseProfileCid(cid, address);
                            nodes.push({
                                id: address,
                                name: parsed.name,
                                metadata: parsed.metadata || cid,
                                ipfsCid: cid,
                                type: 'user',
                                owner: address
                            });
                            registeredAddresses.push(address);
                        } catch (err) {
                            console.warn('query profile failed', address, err);
                        }
                    }
                }

                // 边查询：仅查询已确认注册的地址对
                const edges = [];
                for (const from of registeredAddresses) {
                    for (const to of registeredAddresses) {
                        if (from === to) continue;
                        try {
                            const endorsement = await this.contractQuery('get_endorsement', caller, [from, to]);
                            if (!endorsement) continue;
                            const relationType = Number(endorsement.relationType ?? endorsement.relation_type ?? 1);
                            edges.push({
                                from,
                                to,
                                relationship: this.relationshipTypeLabel(relationType),
                                proofHash: endorsement.proofHash || endorsement.proof_hash || '',
                                createdAt: endorsement.createdAt || endorsement.created_at || ''
                            });
                        } catch (err) {
                            console.warn('query endorsement failed', from, to, err);
                        }
                    }
                }

                return { nodes, edges };
            },
        // refreshFromIndexer
        async refreshFromIndexer() {
                if (this.useMockMode) {
                    this.initMockGraphData();
                    this.renderG6Graph();
                    this.addLog("📡 Mock模式刷新图谱 (模拟索引器事件)");
                    return;
                }
                try {
                    await this.requestIndexerSync();
                    let graph = null;
                    try {
                        graph = await this.buildGraphFromApi();
                        this.indexerStatus = `索引器已同步 ${new Date().toLocaleTimeString()}`;
                    } catch (apiErr) {
                        console.warn('graphql refresh failed, fallback to chain', apiErr);
                        graph = await this.buildGraphFromChain();
                        this.indexerStatus = `链上直查 ${new Date().toLocaleTimeString()}`;
                    }
                    this.graphData = graph;
                    this.renderG6Graph();
                    await this.refreshAccountRegistrationStatus();
                    this.addLog(`✅ 链上同步成功: ${graph.nodes.length} 节点, ${graph.edges.length} 关系`);
                } catch (err) {
                    console.error(err);
                    this.addLog("❌ 链上同步失败，请检查本地节点、钱包与 metadata");
                    this.indexerStatus = "链上同步失败";
                }
            },
        // uploadIdentityToIpfs
        async uploadIdentityToIpfs() {
                try {
                    const payload = {
                        name: this.newIdentity.name.trim(),
                        metadata: this.newIdentity.metadata.trim()
                    };
                    const response = await axios.post(window.CONTRACT_CONFIG.ipfsUploadUrl, payload);
                    const cid = response?.data?.cid;
                    if (!cid) {
                        throw new Error('IPFS 上传未返回 CID');
                    }
                    return cid;
                } catch (err) {
                    const detail = err?.response?.data?.detail || err?.message || 'IPFS 上传失败';
                    throw new Error(detail);
                }
            },
    }
};
