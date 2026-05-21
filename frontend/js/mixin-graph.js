// SovereignGraph mixin_graph – Vue 2 mixin
window.mixin_graph = {
    methods: {
        // renderG6Graph — 以当前钱包节点为中心，树状展开所有关联节点
        renderG6Graph() {
                const container = document.getElementById('graphCanvas');
                if (!container) return;

                const canvasWidth = container.clientWidth || 700;
                const canvasHeight = 460;
                const cx = canvasWidth / 2;
                const cy = canvasHeight / 2;

                const activeAddress = this.account?.address || '';
                const centerNodeId = this.determineCenterNode(activeAddress);

                const nodesForG6 = this.graphData.nodes.map(n => {
                    const isActive = activeAddress && n.id === activeAddress;
                    const isCenter = n.id === centerNodeId;
                    const isLeaf = !this.graphData.edges.some(e => e.from === n.id || e.to === n.id);
                    return {
                        id: n.id,
                        label: n.name.length > 12 ? n.name.slice(0,10)+'..' : n.name,
                        name: n.name,
                        metadata: n.metadata,
                        ipfsCid: n.ipfsCid || '',
                        owner: n.owner,
                        type: isActive ? 'self' : n.type,
                        size: isCenter ? 52 : (isLeaf ? 38 : 44),
                        fx: isCenter ? cx : undefined,
                        fy: isCenter ? cy : undefined,
                        labelCfg: {
                            style: {
                                fontFamily: 'Microsoft YaHei, SimHei, PingFang SC, sans-serif',
                                fill: isActive ? '#4F46E5' : '#1F2937',
                                fontSize: isCenter ? 12 : 11,
                                fontWeight: isActive ? 'bold' : 'normal'
                            }
                        },
                        style: isActive
                            ? { fill: '#C7D2FE', stroke: '#4F46E5', lineWidth: 2.5 }
                            : isCenter
                                ? { fill: '#DBEAFE', stroke: '#3B82F6', lineWidth: 2 }
                                : { fill: n.type === 'org' ? '#E0E7FF' : (n.type === 'dao' ? '#D1FAE5' : '#FEF3C7'), stroke: '#6366F1', lineWidth: 1.5 }
                    };
                });
                const edgesForG6 = this.graphData.edges.map((e, idx) => ({
                    id: `e${idx}`,
                    source: e.from,
                    target: e.to,
                    relationship: e.relationship,
                    relationLabel: this.relationDisplayLabel(e.relationship),
                    label: this.relationDisplayLabel(e.relationship),
                    type: 'quadratic',
                    curveOffset: idx % 2 === 0 ? 28 : -28,
                    labelCfg: {
                        autoRotate: false,
                        refY: -12,
                        style: { fontFamily: 'Microsoft YaHei, SimHei, PingFang SC, sans-serif', fill: '#475569', fontSize: 11, background: { fill: '#ffffff', padding: [2, 4], radius: 4 } }
                    },
                    style: { stroke: '#94A3B8', lineWidth: 2, endArrow: true }
                }));

                if (this.g6GraphInstance) {
                    this.g6GraphInstance.changeData({ nodes: nodesForG6, edges: edgesForG6 });
                    this.g6GraphInstance.layout();
                    return;
                }

                const graph = new G6.Graph({
                    container: 'graphCanvas',
                    width: canvasWidth,
                    height: canvasHeight,
                    animate: false,
                    layout: {
                        type: 'force',
                        preventOverlap: true,
                        nodeSpacing: 85,
                        linkDistance: 200,
                        nodeStrength: -160,
                        edgeStrength: 0.03,
                        alphaDecay: 0.025,
                        alphaMin: 0.001,
                        maxIteration: 500
                    },
                    modes: {
                        default: ['drag-canvas', 'zoom-canvas', {
                            type: 'drag-node',
                            enableOptimize: true,
                            onlyChangeEmbedding: false
                        }]
                    },
                    defaultNode: { size: 48, labelCfg: { style: { fontFamily: 'Microsoft YaHei, SimHei, PingFang SC, sans-serif', fill: '#1F2937', fontSize: 11 }, position: 'bottom' } },
                    defaultEdge: {
                        type: 'quadratic',
                        labelCfg: {
                            autoRotate: false,
                            refY: -12,
                            style: { fontFamily: 'Microsoft YaHei, SimHei, PingFang SC, sans-serif', fill: '#475569', fontSize: 11, background: { fill: '#ffffff', padding: [2, 4], radius: 4 } }
                        }
                    },
                    nodeStateStyles: { highlight: { stroke: '#F59E0B', lineWidth: 3, fill: '#FDE047' } },
                    edgeStateStyles: { highlight: { stroke: '#EA580C', lineWidth: 3, shadowColor: '#EA580C', shadowBlur: 6 } }
                });
                graph.data({ nodes: nodesForG6, edges: edgesForG6 });
                graph.render();

                graph.on('node:mouseenter', ev => {
                    const model = ev.item.getModel();
                    const full = this.graphData.nodes.find(n => n.id === model.id);
                    if (full) {
                        const meta = full.metadata || '';
                        const shortMeta = meta.length > 30 ? meta.slice(0, 28) + '..' : meta;
                        this.showToast(`${full.name} | ${shortMeta}`, 1500);
                    }
                });
                graph.on('node:click', ev => {
                    const model = ev.item.getModel();
                    this.openNodeDetail(model.id);
                });

                this.g6GraphInstance = graph;

                graph.on('afterlayout', () => {
                    graph.fitView(40);
                });
            },

        // determineCenterNode — 决定以哪个节点为图谱中心
        determineCenterNode(activeAddress) {
                const nodes = this.graphData.nodes;
                const edges = this.graphData.edges;
                if (nodes.length === 0) return null;

                // 1) 当前钱包节点优先
                if (activeAddress && nodes.some(n => n.id === activeAddress)) {
                    return activeAddress;
                }

                // 2) 度数最高的节点
                const degree = {};
                nodes.forEach(n => { degree[n.id] = 0; });
                edges.forEach(e => {
                    if (degree[e.from] !== undefined) degree[e.from]++;
                    if (degree[e.to] !== undefined) degree[e.to]++;
                });
                let best = nodes[0].id;
                let bestDeg = -1;
                for (const [id, deg] of Object.entries(degree)) {
                    if (deg > bestDeg) { bestDeg = deg; best = id; }
                }
                return best;
            },

        // centerOnActiveNode — 切换账户时重新以新节点为中心布局
        centerOnActiveNode() {
                const graph = this.g6GraphInstance;
                if (!graph) return;

                const activeAddress = this.account?.address || '';
                const centerNodeId = this.determineCenterNode(activeAddress);
                if (!centerNodeId) { graph.fitView(30); return; }

                const canvasWidth = graph.getWidth();
                const canvasHeight = graph.getHeight();
                const cx = canvasWidth / 2;
                const cy = canvasHeight / 2;

                // 更新中心节点 fx/fy，旧中心节点清除
                const nodes = graph.getNodes();
                nodes.forEach(node => {
                    const model = node.getModel();
                    if (model.id === centerNodeId) {
                        graph.updateItem(node, { fx: cx, fy: cy, size: 52 });
                    } else if (model.fx !== undefined) {
                        graph.updateItem(node, { fx: undefined, fy: undefined, size: 44 });
                    }
                });

                graph.layout();
                setTimeout(() => graph.fitView(40), 350);
            },

        // openNodeDetail
        openNodeDetail(nodeId) {
                const node = (this.graphData.nodes || []).find(n => n.id === nodeId);
                if (!node) return;
                const degree = this.getNodeDegree(node.id);
                this.selectedNodeDetail = {
                    ...node,
                    address: node.owner || node.address || node.id,
                    ipfsCid: node.ipfsCid || node.cid || '',
                    metadataText: this.formatMetadata(node.metadata),
                    inDegree: degree.inDegree,
                    outDegree: degree.outDegree
                };
            },
        // closeNodeDetail
        closeNodeDetail() {
                this.selectedNodeDetail = null;
            },
        // getNodeDegree
        getNodeDegree(nodeId) {
                return (this.graphData.edges || []).reduce((degree, edge) => {
                    if (edge.to === nodeId) degree.inDegree += 1;
                    if (edge.from === nodeId) degree.outDegree += 1;
                    return degree;
                }, { inDegree: 0, outDegree: 0 });
            },
        // formatMetadata
        formatMetadata(metadata) {
                if (!metadata) return '';
                if (typeof metadata === 'object') {
                    return JSON.stringify(metadata, null, 2);
                }
                const text = String(metadata);
                try {
                    return JSON.stringify(JSON.parse(text), null, 2);
                } catch (err) {
                    return text;
                }
            },
        // applySemanticHighlight
        applySemanticHighlight() {
                if (!this.g6GraphInstance) return;
                if (!this.semanticQuery.trim()) {
                    this.resetHighlight();
                    return;
                }
                const tokens = this.semanticQuery.toLowerCase().split(/\s+/).filter(Boolean);
                const linkedNodeIds = new Set();
                let matchedEdges = 0;

                this.g6GraphInstance.getEdges().forEach(edge => {
                    const model = edge.getModel();
                    const edgeKeywords = this.buildSearchKeywords(
                        model.relationship,
                        model.relationLabel,
                        this.relationSearchTerms(model.relationship),
                        model.source,
                        model.target
                    );
                    const match = tokens.every(t => edgeKeywords.includes(t));
                    this.g6GraphInstance.setItemState(edge, 'highlight', match);
                    if (match) {
                        matchedEdges++;
                        linkedNodeIds.add(model.source);
                        linkedNodeIds.add(model.target);
                    }
                });

                let matchedNodes = 0;
                this.g6GraphInstance.getNodes().forEach(node => {
                    const model = node.getModel();
                    const nodeKeywords = this.buildSearchKeywords(model.id, model.name, model.metadata, model.type);
                    const match = tokens.every(t => nodeKeywords.includes(t)) || linkedNodeIds.has(model.id);
                    this.g6GraphInstance.setItemState(node, 'highlight', match);
                    if (match) matchedNodes++;
                });

                this.g6GraphInstance.paint();

                if (matchedNodes === 0 && matchedEdges === 0) {
                    this.showToast(`未找到匹配 "${this.semanticQuery}" 的节点或关系`, 2500);
                    return;
                }

                const highlightIds = [];
                this.g6GraphInstance.getNodes().forEach(node => {
                    if (node.hasState('highlight')) highlightIds.push(node.getID());
                });
                if (highlightIds.length > 0) {
                    try {
                        this.g6GraphInstance.focusItems(highlightIds, false, { duration: 400, easing: 'easeCubic' });
                    } catch (_) {
                        this.g6GraphInstance.fitView(20);
                    }
                }
                this.showToast(`找到 ${matchedNodes} 个节点, ${matchedEdges} 条关系`, 2000);
            },
        // resetHighlight
        resetHighlight() {
                if (!this.g6GraphInstance) return;
                this.semanticQuery = '';
                this.g6GraphInstance.getNodes().forEach(node => this.g6GraphInstance.clearItemStates(node));
                this.g6GraphInstance.getEdges().forEach(edge => this.g6GraphInstance.clearItemStates(edge));
                this.g6GraphInstance.paint();
                this.g6GraphInstance.fitView(20);
                this.showToast('已重置搜索', 1500);
            },
    }
};
