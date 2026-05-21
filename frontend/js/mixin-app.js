// SovereignGraph mixin_app – Vue 2 mixin
window.mixin_app = {
    methods: {
        // showToast
        showToast(msg, duration = 3000) {
                this.toastMessage = msg;
                if (window._toastTimer) clearTimeout(window._toastTimer);
                window._toastTimer = setTimeout(() => { this.toastMessage = ''; }, duration);
            },
        // shortenAddress
        shortenAddress(addr) { return addr ? addr.slice(0,6)+'...'+addr.slice(-4) : ''; },
        // accountChipLabel
        accountChipLabel(account) {
                if (!account) return '';
                const known = window.CONTRACT_CONFIG.knownAccounts.find(item => item.address === account.address)?.label;
                const displayName = account.meta?.name || known || '账户';
                return `${displayName} · ${this.shortenAddress(account.address)}`;
            },
        // accountStatusText
        accountStatusText(address) {
                const state = this.accountRegistrationStatus[address];
                if (state === true) return '已注册';
                if (state === false) return '未注册';
                // Mock mode: null means haven't synced from graph data yet
                if (this.useMockMode) return '检测中';
                // RealNet: chain not reachable at all
                if (!this.contractReady) return '链未连接';
                // RealNet: chain connected but every contract query failed
                if (this._registrationAllFailed) {
                    const detail = (this._registrationErrorDetail || '').toLowerCase();
                    if (detail.includes('not found') || detail.includes('not deployed') || detail.includes('contract')) {
                        return '未部署';
                    }
                    if (detail.includes('method') || detail.includes('selector') || detail.includes('未找到')) {
                        return 'ABI不匹配';
                    }
                    return '合约异常';
                }
                // RealNet: loading in progress
                if (this.registrationStatusLoading) return '检测中';
                // RealNet: individual query failed but not all
                return '未确认';
            },
        // registeredTargetOptions
        registeredTargetOptions() {
                const registeredAddresses = new Set();
                const options = [];
                const activeAddress = this.account?.address;

                (this.graphData.nodes || []).forEach(node => {
                    const address = node.owner || node.id;
                    if (!address || typeof address !== 'string' || !address.startsWith('5')) return;
                    if (address === activeAddress) return;
                    registeredAddresses.add(address);
                });

                Object.entries(this.accountRegistrationStatus || {}).forEach(([address, registered]) => {
                    if (registered === true && address !== activeAddress) {
                        registeredAddresses.add(address);
                    }
                });

                [...registeredAddresses].forEach(address => {
                    const known = window.CONTRACT_CONFIG.knownAccounts.find(item => item.address === address);
                    const connected = this.availableAccounts.find(item => item.address === address);
                    const graphNode = (this.graphData.nodes || []).find(node => (node.owner || node.id) === address);
                    const name = connected?.meta?.name || known?.label || graphNode?.name || this.shortenAddress(address);
                    options.push({
                        address,
                        label: `${name} · ${this.shortenAddress(address)}`
                    });
                });

                return options.sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
            },
        // accountStatusClass
        accountStatusClass(address, isActive) {
                const state = this.accountRegistrationStatus[address];
                if (state === true) {
                    return isActive ? 'bg-emerald-100 text-emerald-800' : 'bg-emerald-100 text-emerald-700';
                }
                if (state === false) {
                    return isActive ? 'bg-amber-100 text-amber-800' : 'bg-amber-100 text-amber-700';
                }
                // RealNet error states
                if (!this.useMockMode) {
                    if (!this.contractReady || this._registrationAllFailed) {
                        return isActive ? 'bg-white/20 text-white' : 'bg-red-100 text-red-600';
                    }
                }
                return isActive ? 'bg-white/20 text-white' : 'bg-gray-200 text-gray-600';
            },
        // syncMockAccountStatuses
        syncMockAccountStatuses() {
                const registeredAddresses = new Set(
                    (this.graphData.nodes || [])
                        .map(node => node.owner || node.id)
                        .filter(value => typeof value === 'string' && value.startsWith('5'))
                );
                const next = {};
                this.availableAccounts.forEach(item => {
                    next[item.address] = registeredAddresses.has(item.address);
                });
                this.accountRegistrationStatus = next;
            },
        // refreshAccountRegistrationStatus
        async refreshAccountRegistrationStatus() {
                if (!this.availableAccounts.length) {
                    this.accountRegistrationStatus = {};
                    return;
                }
                if (this.useMockMode) {
                    this.syncMockAccountStatuses();
                    return;
                }
                if (!this.contractReady && !(await this.initRealApi())) {
                    // Chain not reachable — mark all as unconfirmed so UI shows "链未连接"
                    const fallback = {};
                    this.availableAccounts.forEach(item => { fallback[item.address] = null; });
                    this.accountRegistrationStatus = fallback;
                    return;
                }
                this.registrationStatusLoading = true;
                const next = {};
                let allQueriesFailed = true;
                let firstErrorMsg = '';
                try {
                    const caller = this.account?.address || this.availableAccounts[0]?.address;
                    for (const wallet of this.availableAccounts) {
                        try {
                            const registered = await this.contractQuery('is_registered', caller, [wallet.address]);
                            next[wallet.address] = Boolean(registered);
                            allQueriesFailed = false;
                        } catch (err) {
                            if (!firstErrorMsg) firstErrorMsg = err.message || String(err);
                            console.warn('[registration] is_registered query failed for', wallet.address, err);
                            next[wallet.address] = null;
                        }
                    }
                    if (allQueriesFailed && this.availableAccounts.length > 0) {
                        this._registrationAllFailed = true;
                        this._registrationErrorDetail = firstErrorMsg;
                        this.addLog(`⚠️ 合约查询全部失败: ${firstErrorMsg}`);
                    } else {
                        this._registrationAllFailed = false;
                        this._registrationErrorDetail = '';
                    }
                    this.accountRegistrationStatus = next;
                } finally {
                    this.registrationStatusLoading = false;
                }
            },
        // setMockMode
        setMockMode(isMock) {
                this.useMockMode = isMock;
                this._registrationAllFailed = false;
                if (isMock) {
                    this.indexerStatus = 'Mock 数据模式 (本地模拟)';
                    this.initMockGraphData();
                    this.renderG6Graph();
                    this.syncMockAccountStatuses();
                    this.addLog("切换到 Mock 模式，用于前端快速演示");
                } else {
                    this.indexerStatus = '正在连接本地节点与合约...';
                    // Clear mock data when switching to RealNet mode
                    this.graphData = { nodes: [], edges: [] };
                    this.renderG6Graph();
                    this.initRealApi().then(async ok => {
                        if (ok) {
                            await this.fetchSystemStatus();
                            await this.refreshFromIndexer();
                            await this.refreshAccountRegistrationStatus();
                        }
                    });
                    this.addLog("切换到 RealNet 模式，对接本地 dev 节点与 ink! 合约");
                }
            },
        // statusDotClass
        statusDotClass(status) {
                const state = status?.state || 'pending';
                if (state === 'ok') return 'status-connected';
                if (state === 'error') return 'status-disconnected';
                return 'status-pending';
            },
        // initMockGraphData
        initMockGraphData() {
                const defaultNodes = [
                    { id: "node_pf", name: "Portaldot 基金会", metadata: "生态支持", ipfsCid: "bafybeigdyrzt5mockpf", type: "org" },
                    { id: "node_builderdao", name: "BuilderDAO", metadata: "早期贡献者", ipfsCid: "bafybeigdyrzt5mockbuilderdao", type: "dao" },
                    { id: "node_alice", name: "Alice Dev", metadata: "核心工程师", ipfsCid: "bafybeigdyrzt5mockalice", type: "user" }
                ];
                const defaultEdges = [
                    { from: "node_pf", to: "node_builderdao", relationship: "ENDORSEMENT" },
                    { from: "node_builderdao", to: "node_alice", relationship: "COLLABORATION" }
                ];
                if (this.graphData.nodes.length === 0) {
                    this.graphData = { nodes: defaultNodes, edges: defaultEdges };
                } else {
                    // 保留已有节点, 但防止覆盖
                    if (this.graphData.nodes.length === 0) this.graphData.nodes = defaultNodes;
                    if (this.graphData.edges.length === 0) this.graphData.edges = defaultEdges;
                }
            },
        // updateGraphData
        updateGraphData(newNodes = null, newEdges = null) {
                if (newNodes) this.graphData.nodes = newNodes;
                if (newEdges) this.graphData.edges = newEdges;
                this.renderG6Graph();
            },
        // mintSBT
        async mintSBT() {
                if (!this.account) { this.showToast("请先连接钱包"); return; }
                if (!this.newIdentity.name.trim()) { this.showToast("请输入身份昵称"); return; }
                this.minting = true;
                try {
                    if (this.useMockMode) {
                        // Mock模式: 模拟合约调用 + 索引器更新
                        await new Promise(r => setTimeout(r, 1200));
                        const newNodeId = `sbt_${Date.now()}_${Math.random().toString(36).substr(2,6)}`;
                        const newNode = {
                            id: newNodeId,
                            name: this.newIdentity.name,
                            metadata: this.newIdentity.metadata || "Sovereign Entity",
                            ipfsCid: '',
                            type: "user",
                            owner: this.account.address
                        };
                        this.graphData.nodes.push(newNode);
                        this.lastMintTx = `铸造成功 ID:${newNodeId} (模拟消耗 0.02 POT)`;
                        this.addLog(`✅ [Mock] 铸造SBT节点: ${newNode.name} , 触发索引器事件重构RDF`);
                        this.renderG6Graph();
                        this.showToast("铸造成功 (Mock模式)");
                    } else {
                        const cid = await this.uploadIdentityToIpfs();
                        await this.dryRunTx('register_identity', this.account.address, [cid]);
                        this.addLog("⛓️ 正在调用 register_identity 上链...");
                        const txHash = await this.executeContractTx('register_identity', [cid]);
                        this.rememberKnownAddress(this.account.address);
                        this.lastMintTx = `register_identity 已提交: ${txHash}`;
                        this.addLog(`✅ [真实链] 身份注册成功: ${this.account.address}`);
                        await this.refreshFromIndexer();
                        this.showToast("身份已成功写入本地合约");
                    }
                    this.newIdentity.name = '';
                    this.newIdentity.metadata = '';
                } catch(e) {
                    console.error(e);
                    this.showToast("注册失败: " + this.humanizeContractError(e));
                } finally {
                    this.minting = false;
                }
            },
        // createRelationship
        async createRelationship() {
                if (!this.account) { this.showToast("请连接钱包"); return; }
                if (!this.newEdge.fromId.trim() || !this.newEdge.toId.trim()) { this.showToast("请输入源地址和目标地址"); return; }
                this.creatingEdge = true;
                try {
                    if (this.useMockMode) {
                        await new Promise(r => setTimeout(r, 1200));
                        const newRel = {
                            from: this.newEdge.fromId,
                            to: this.newEdge.toId,
                            relationship: this.newEdge.relationshipType,
                            zkProof: "zk_snark_simulated"
                        };
                        this.graphData.edges.push(newRel);
                        this.lastEdgeTx = `关系: ${newRel.from} → ${newRel.to} (${newRel.relationship})  模拟消耗0.015 POT`;
                        this.addLog(`🔗 [Mock] ZK关系边建立, 链上验证证明通过, 已存入图谱`);
                        this.renderG6Graph();
                        this.showToast("关系建立模拟成功");
                    } else {
                        const fromAddress = this.resolveKnownAddress(this.newEdge.fromId);
                        const targetAddress = this.resolveKnownAddress(this.newEdge.toId);
                        if (!targetAddress) {
                            throw new Error('请输入有效的目标地址');
                        }
                        if (fromAddress !== this.account.address) {
                            throw new Error('RealNet 模式下源地址必须与当前连接钱包一致');
                        }
                        const relationType = this.relationshipTypeValue(this.newEdge.relationshipType);
                        const proofHash = this.makeProofHash(`${fromAddress}|${targetAddress}|${relationType}|${Date.now()}`);
                        await this.dryRunTx('endorse', this.account.address, [targetAddress, relationType, proofHash]);
                        this.addLog("⛓️ 正在调用 endorse 上链...");
                        const txHash = await this.executeContractTx('endorse', [targetAddress, relationType, proofHash]);
                        this.rememberKnownAddress(fromAddress);
                        this.rememberKnownAddress(targetAddress);
                        this.lastEdgeTx = `endorse 已提交: ${txHash}`;
                        await this.refreshFromIndexer();
                        this.addLog(`✅ [真实链] 背书已上链: ${this.shortenAddress(fromAddress)} -> ${this.shortenAddress(targetAddress)}`);
                        this.showToast("链上背书成功");
                    }
                    this.newEdge.fromId = this.account?.address || '';
                    this.newEdge.toId = '';
                } catch(e) {
                    this.showToast("建立关系失败: " + this.humanizeContractError(e));
                } finally {
                    this.creatingEdge = false;
                }
            },
        // addLog
        addLog(msg) {
                const time = dayjs().format('HH:mm:ss');
                this.eventLogs.unshift(`[${time}] ${msg}`);
                if (this.eventLogs.length > 22) this.eventLogs.pop();
            },
    }
};
