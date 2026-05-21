// SovereignGraph mixin_wallet – Vue 2 mixin
window.mixin_wallet = {
    methods: {
        // initRealApi
        async initRealApi() {
                try {
                    if (this.contractReady && this.polkadotApi && this.sbtContract) {
                        return true;
                    }
                    const { ApiPromise, WsProvider } = await import('https://cdn.jsdelivr.net/npm/@polkadot/api@16.5.6/+esm');
                    const { ContractPromise } = await import('https://cdn.jsdelivr.net/npm/@polkadot/api-contract@16.5.6/+esm');
                    if (!this.contractMetadata) {
                        const metadataResp = await fetch(window.CONTRACT_CONFIG.metadataUrl);
                        if (!metadataResp.ok) {
                            throw new Error(`无法加载合约 metadata: ${metadataResp.status}`);
                        }
                        this.contractMetadata = await metadataResp.json();
                    }
                    let lastError = null;
                    for (const rpcUrl of window.CONTRACT_CONFIG.rpcUrls) {
                        try {
                            const provider = new WsProvider(rpcUrl);
                            const api = await ApiPromise.create({ provider });
                            this.polkadotApi = api;
                            this.activeRpcUrl = rpcUrl;
                            break;
                        } catch (rpcError) {
                            lastError = rpcError;
                            console.warn(`RPC connect failed: ${rpcUrl}`, rpcError);
                        }
                    }
                    if (!this.polkadotApi) {
                        throw lastError || new Error('所有 RPC 地址连接失败');
                    }
                    this.sbtContract = new ContractPromise(
                        this.polkadotApi,
                        this.contractMetadata,
                        window.CONTRACT_CONFIG.contractAddress
                    );
                    this.contractReady = true;
                    this.addLog(`✅ 已连接本地节点 ${this.activeRpcUrl}`);
                    this.addLog(`✅ 已加载合约 ${window.CONTRACT_CONFIG.contractAddress}`);
                    this.indexerStatus = '链上直连已就绪';
                    this.healthStatus.contract = { state: 'ok', label: '已连接' };
                    return true;
                } catch(e) {
                    console.warn(e);
                    this.contractReady = false;
                    this.addLog(`⚠️ 真实链初始化失败: ${e.message || e}`);
                    this.indexerStatus = '真实链错误';
                    this.healthStatus.contract = { state: 'error', label: '连接失败' };
                    return false;
                }
            },
        // snakeToCamel
        snakeToCamel(name) {
                return name.replace(/_([a-z])/g, (_, chr) => chr.toUpperCase());
            },
        // getMessageAccessor
        getMessageAccessor(container, label) {
                if (!container) return null;
                return container[label] || container[this.snakeToCamel(label)] || null;
            },
        // getExtensionDapp
        async getExtensionDapp() {
                if (this.extensionDapp) {
                    return this.extensionDapp;
                }
                this.extensionDapp = await import('https://cdn.jsdelivr.net/npm/@polkadot/extension-dapp@0.46.5/+esm');
                return this.extensionDapp;
            },
        // getGasLimit
        getGasLimit() {
                return this.polkadotApi.registry.createType('WeightV2', {
                    refTime: '1000000000000',
                    proofSize: '262144'
                });
            },
        // normalizeCodecValue
        normalizeCodecValue(value) {
                if (value && typeof value.toJSON === 'function') {
                    value = value.toJSON();
                }
                if (Array.isArray(value)) {
                    return value.map(item => this.normalizeCodecValue(item));
                }
                if (value && typeof value === 'object') {
                    const keys = Object.keys(value);
                    if (keys.length === 1) {
                        const key = keys[0];
                        const nested = value[key];
                        if (key === 'Ok' || key === 'ok' || key === 'Some' || key === 'some') {
                            return this.normalizeCodecValue(nested);
                        }
                        if (key === 'Err' || key === 'err') {
                            return { __error: typeof nested === 'string' ? nested : JSON.stringify(nested) };
                        }
                        if (key === 'None' || key === 'none') {
                            return null;
                        }
                    }
                    const plain = {};
                    keys.forEach(key => {
                        plain[key] = this.normalizeCodecValue(value[key]);
                    });
                    return plain;
                }
                return value;
            },
        // formatDispatchError
        formatDispatchError(dispatchError) {
                try {
                    if (dispatchError?.isModule && dispatchError.asModule) {
                        const decoded = this.polkadotApi.registry.findMetaError(dispatchError.asModule);
                        return `${decoded.section}.${decoded.name}: ${decoded.docs.join(' ')}`.trim();
                    }
                    const normalized = this.normalizeCodecValue(dispatchError);
                    const moduleErr = normalized?.module;
                    if (moduleErr?.index !== undefined && moduleErr?.error) {
                        const moduleType = this.polkadotApi.registry.createType('DispatchErrorModule', {
                            index: moduleErr.index,
                            error: moduleErr.error
                        });
                        const decoded = this.polkadotApi.registry.findMetaError(moduleType);
                        return `${decoded.section}.${decoded.name}: ${decoded.docs.join(' ')}`.trim();
                    }
                    return dispatchError?.toString?.() || JSON.stringify(normalized || dispatchError);
                } catch (_) {
                    const normalized = this.normalizeCodecValue(dispatchError);
                    return dispatchError?.toString?.() || JSON.stringify(normalized || dispatchError);
                }
            },
        // humanizeContractError
        humanizeContractError(error) {
                const raw = typeof error === 'string'
                    ? error
                    : (error?.message || error?.toString?.() || '未知错误');
                const lower = raw.toLowerCase();

                if (raw.includes('AlreadyRegistered')) {
                    return '该地址已经注册过身份，不能重复注册。';
                }
                if (raw.includes('TargetNotRegistered')) {
                    return '目标地址还没有注册身份，请先用目标账户完成一次注册。';
                }
                if (raw.includes('IdentityNotRegistered')) {
                    return '当前地址还没有注册身份，请先完成注册。';
                }
                if (raw.includes('SelfEndorsement')) {
                    return '不能给自己建立背书或关系。';
                }
                if (raw.includes('AlreadyEndorsed')) {
                    return '这两个地址之间已经建立过关系，不能重复提交。';
                }
                if (raw.includes('Invalid base58 character') || raw.includes('Decoding alice') || raw.includes('Decoding bob')) {
                    return '目标地址格式不正确。你可以输入完整地址，或使用 Alice / Bob 别名。';
                }
                if (lower.includes('insufficientbalance') || lower.includes('outoffunds') || lower.includes('余额不足')) {
                    return '账户余额不足，无法支付 gas 或存储押金。请先转入测试币。';
                }
                if (lower.includes('storage') && (lower.includes('deposit') || lower.includes('押金'))) {
                    return '当前账户无法支付存储押金，请先补充测试币后再试。';
                }
                if (lower.includes('user denied') || lower.includes('rejected') || lower.includes('cancelled')) {
                    return '你取消了钱包签名，本次交易没有提交。';
                }
                if (lower.includes('all rpc') || raw.includes('所有 RPC 地址连接失败')) {
                    return '本地链节点未连接成功，请确认 `substrate-contracts-node --dev` 正在运行。';
                }
                if (lower.includes('ipfs 上传失败') || lower.includes('failed to establish a new connection')) {
                    return '本地 IPFS 未启动，请确认 `ipfs daemon` 正在运行。';
                }
                if (lower.includes('accountid') || lower.includes('cannot lookup')) {
                    return '目标地址无法识别，请检查地址是否完整，或改用已注册账户地址。';
                }
                return raw;
            },
        // contractQuery
        async contractQuery(label, caller, args = []) {
                if (!this.contractReady && !(await this.initRealApi())) {
                    throw new Error('合约未初始化');
                }
                const queryFn = this.getMessageAccessor(this.sbtContract.query, label);
                if (!queryFn) {
                    throw new Error(`未找到合约查询方法: ${label}`);
                }
                const { result, output } = await queryFn.call(
                    this.sbtContract.query,
                    caller,
                    { gasLimit: this.getGasLimit(), storageDepositLimit: null },
                    ...args
                );
                if (result?.isErr) {
                    throw new Error(this.humanizeContractError(result.asErr?.toString?.() || result.toString()));
                }
                const normalized = this.normalizeCodecValue(output);
                if (normalized && normalized.__error) {
                    throw new Error(this.humanizeContractError(normalized.__error));
                }
                return normalized;
            },
        // dryRunTx
        dryRunTx(label, caller, args = []) {
                return this.contractQuery(label, caller, args);
            },
        // executeContractTx
        async executeContractTx(label, args = []) {
                if (!this.account) throw new Error('请先连接钱包');
                if (!this.contractReady && !(await this.initRealApi())) {
                    throw new Error('合约未初始化');
                }
                const txFn = this.getMessageAccessor(this.sbtContract.tx, label);
                if (!txFn) {
                    throw new Error(`未找到合约交易方法: ${label}`);
                }
                const { web3FromAddress } = await this.getExtensionDapp();
                const injector = await web3FromAddress(this.account.address);
                const tx = txFn.call(
                    this.sbtContract.tx,
                    { gasLimit: this.getGasLimit(), storageDepositLimit: null, value: 0 },
                    ...args
                );
                return new Promise((resolve, reject) => {
                    let unsub = null;
                    tx.signAndSend(
                        this.account.address,
                        { signer: injector.signer },
                        result => {
                            if (result.dispatchError) {
                                const err = this.humanizeContractError(this.formatDispatchError(result.dispatchError));
                                if (unsub) unsub();
                                reject(new Error(err));
                                return;
                            }
                            if (result.status.isInBlock || result.status.isFinalized) {
                                const txHash = tx.hash.toHex();
                                if (unsub) unsub();
                                resolve(txHash);
                            }
                        }
                    ).then(fn => {
                        unsub = fn;
                    }).catch(err => reject(new Error(this.humanizeContractError(err))));
                });
            },
        // rememberKnownAddress
        rememberKnownAddress(address) {
                if (!address) return;
                const key = 'trustgraphKnownAccounts';
                const existing = JSON.parse(localStorage.getItem(key) || '[]');
                if (!existing.includes(address)) {
                    existing.push(address);
                    localStorage.setItem(key, JSON.stringify(existing));
                }
            },
        // updateWalletStatus
        updateWalletStatus() {
                if (!this.account) {
                    this.connected = false;
                    this.walletStatus = '未连接';
                    return;
                }
                this.connected = true;
                const count = this.availableAccounts.length;
                this.walletStatus = count > 1
                    ? `已连接 ${count} 个账户 · 当前 ${this.shortenAddress(this.account.address)}`
                    : `已连接 ${this.shortenAddress(this.account.address)}`;
            },
        // switchActiveAccount
        async switchActiveAccount(address) {
                const selected = this.availableAccounts.find(item => item.address === address);
                if (!selected) {
                    throw new Error('未找到要切换的账户');
                }
                this.account = { address: selected.address, meta: selected.meta || {} };
                this.newEdge.fromId = selected.address;
                this.rememberKnownAddress(selected.address);
                this.updateWalletStatus();
                this.addLog(`👛 已切换当前账户: ${selected.address}`);
                if (!this.useMockMode) {
                    await this.refreshFromIndexer();
                } else {
                    this.syncMockAccountStatuses();
                }
            },
        // pickRegisteredTarget
        pickRegisteredTarget(address) {
                if (!address) return;
                this.newEdge.toId = address;
                this.showToast(`已选择目标地址: ${this.shortenAddress(address)}`, 1800);
            },
        // getKnownAccounts
        getKnownAccounts() {
                const saved = JSON.parse(localStorage.getItem('trustgraphKnownAccounts') || '[]');
                const merged = [
                    ...window.CONTRACT_CONFIG.knownAccounts.map(item => item.address),
                    ...saved,
                    this.account?.address
                ].filter(Boolean);
                return [...new Set(merged)];
            },
        // resolveKnownAddress
        resolveKnownAddress(input) {
                const value = (input || '').trim();
                if (!value) return '';
                const lower = value.toLowerCase();
                const known = window.CONTRACT_CONFIG.knownAccounts.find(item =>
                    item.address === value ||
                    item.label.toLowerCase() === lower
                );
                return known ? known.address : value;
            },
        // parseProfileCid
        parseProfileCid(cid, address) {
                const defaultName = (window.CONTRACT_CONFIG.knownAccounts.find(item => item.address === address)?.label) || this.shortenAddress(address);
                if (!cid) {
                    return { name: defaultName, metadata: '' };
                }
                try {
                    const parsed = JSON.parse(cid);
                    return {
                        name: parsed.name || defaultName,
                        metadata: parsed.metadata || ''
                    };
                } catch {
                    return {
                        name: defaultName,
                        metadata: cid
                    };
                }
            },
        // encodeIdentityCid
        encodeIdentityCid() {
                return JSON.stringify({
                    name: this.newIdentity.name.trim(),
                    metadata: this.newIdentity.metadata.trim()
                });
            },
        // relationshipTypeValue
        relationshipTypeValue(type) {
                const map = {
                    COLLABORATION: 0,
                    ENDORSEMENT: 1,
                    CONTRIBUTION: 2
                };
                return map[type] ?? 1;
            },
        // relationshipTypeLabel
        relationshipTypeLabel(value) {
                const map = {
                    0: 'COLLABORATION',
                    1: 'ENDORSEMENT',
                    2: 'CONTRIBUTION'
                };
                return map[value] || 'ENDORSEMENT';
            },
        // relationDisplayLabel
        relationDisplayLabel(type) {
                const map = {
                    COLLABORATION: '协作',
                    ENDORSEMENT: '背书',
                    CONTRIBUTION: '贡献'
                };
                return map[type] || type || '关系';
            },
        // relationSearchTerms
        relationSearchTerms(type) {
                const map = {
                    COLLABORATION: '协作 collaboration 合作 co-build builderdao',
                    ENDORSEMENT: '背书 endorsement 推荐 trust attest',
                    CONTRIBUTION: '贡献 contribution 代码贡献 code commit pr github',
                    // 中文别名 (RealNet 模式下可能传入中文标签)
                    '协作': 'collaboration 合作 co-build builderdao',
                    '背书': 'endorsement 推荐 trust attest',
                    '贡献': 'contribution 代码贡献 code commit pr github'
                };
                return map[type] || String(type || '');
            },
        // buildSearchKeywords
        buildSearchKeywords(...values) {
                return values
                    .filter(item => item !== undefined && item !== null && item !== '')
                    .join(' ')
                    .toLowerCase();
            },
        // makeProofHash
        makeProofHash(seed) {
                const bytes = Array.from(new TextEncoder().encode(seed));
                const hex = bytes.map(item => item.toString(16).padStart(2, '0')).join('');
                return `0x${(hex + window.CONTRACT_CONFIG.defaultProofHash.slice(2)).slice(0, 64)}`;
            },
        // faucetDistribute — Alice → other accounts (dev chain only)
        async faucetDistribute() {
                if (this.faucetRunning) return;
                if (!this.polkadotApi) {
                    if (!(await this.initRealApi())) {
                        this.showToast('请先连接链节点 (RealNet 模式)');
                        return;
                    }
                }
                const nonAlice = this.availableAccounts.filter(
                    w => w.address !== '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY'
                );
                if (nonAlice.length === 0) {
                    this.showToast('只有 Alice 账户，无需分发');
                    return;
                }
                this.faucetRunning = true;
                try {
                    const { Keyring } = await import('https://cdn.jsdelivr.net/npm/@polkadot/api@16.5.6/+esm');
                    const keyring = new Keyring({ type: 'sr25519' });
                    const alice = keyring.addFromUri('//Alice');
                    const UNIT = 1_000_000_000_000n;
                    const amount = 1000n * UNIT;
                    let funded = 0;
                    for (const wallet of nonAlice) {
                        try {
                            const { data: bal } = await this.polkadotApi.query.system.account(wallet.address);
                            if (BigInt(bal.free.toString()) >= amount / 2n) continue;
                            const tx = this.polkadotApi.tx.balances.transferKeepAlive(wallet.address, amount);
                            await new Promise((resolve, reject) => {
                                tx.signAndSend(alice, result => {
                                    if (result.dispatchError) {
                                        reject(new Error('transfer failed'));
                                    } else if (result.status.isInBlock || result.status.isFinalized) {
                                        resolve(result);
                                    }
                                });
                            });
                            funded++;
                            this.addLog(`💰 Alice → ${this.shortenAddress(wallet.address)} 1,000 UNIT`);
                        } catch (e) { console.warn('faucet skip', wallet.address, e); }
                    }
                    this.showToast(funded > 0
                        ? `✅ 已向 ${funded} 个账户各转入 1,000 UNIT`
                        : '所有账户已有足够余额');
                } catch (err) {
                    this.showToast('水龙头失败: ' + (err.message || err));
                } finally {
                    this.faucetRunning = false;
                }
            },
        // connectWallet
        async connectWallet() {
                if (this.connecting) return;
                this.connecting = true;
                try {
                    const { web3Enable, web3Accounts } = await this.getExtensionDapp();
                    const extensions = await web3Enable('SovereignGraph');
                    if (extensions.length === 0) {
                        alert("未检测到钱包扩展。SubWallet、Talisman、Polkadot.js 都支持，但请务必在系统浏览器中打开此页面，不要使用 IDE 内置预览。打开后确认已在扩展里允许当前站点访问。");
                        this.walletStatus = '未检测到扩展';
                        return;
                    }
                    const accounts = await web3Accounts();
                    if (accounts.length === 0) {
                        alert("未找到账户");
                        return;
                    }
                    this.availableAccounts = accounts.map(item => ({
                        address: item.address,
                        meta: item.meta || {}
                    }));
                    const currentAddress = this.account?.address;
                    const nextAccount = this.availableAccounts.find(item => item.address === currentAddress) || this.availableAccounts[0];
                    this.account = { address: nextAccount.address, meta: nextAccount.meta || {} };
                    this.newEdge.fromId = nextAccount.address;
                    this.rememberKnownAddress(nextAccount.address);
                    this.updateWalletStatus();
                    this.availableAccounts.forEach(item => {
                        if (!(item.address in this.accountRegistrationStatus)) {
                            this.$set(this.accountRegistrationStatus, item.address, null);
                        }
                    });
                    this.addLog(`🔌 钱包已连接 ${this.availableAccounts.length} 个账户，当前账户: ${nextAccount.address}`);
                    if (!this.useMockMode) {
                        await this.initRealApi();
                        await this.refreshFromIndexer();
                        await this.refreshAccountRegistrationStatus();
                    } else {
                        this.syncMockAccountStatuses();
                    }
                } catch(err) {
                    this.walletStatus = '连接失败';
                    console.error(err);
                    alert(`连接失败: ${err.message || err}`);
                } finally {
                    this.connecting = false;
                }
            },
    }
};
