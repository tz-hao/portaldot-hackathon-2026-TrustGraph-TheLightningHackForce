from typing import List, Optional
from dataclasses import dataclass

@dataclass
class GraphNode:
    address: str
    ipfs_cid: str
    registered_at: str
    in_degree: int
    out_degree: int
    total_score: str

@dataclass
class GraphEdge:
    from_address: str
    to_address: str
    fee_paid: str

@dataclass
class GraphStats:
    total_nodes: int
    total_edges: int
    max_in_degree: int
    max_out_degree: int
    highest_score_node: Optional[str]

@dataclass
class KnowledgeGraph:
    nodes: List[GraphNode]
    edges: List[GraphEdge]
    stats: GraphStats