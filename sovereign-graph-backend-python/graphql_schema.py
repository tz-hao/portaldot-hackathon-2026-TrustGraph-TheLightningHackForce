import json
from typing import Optional

import strawberry
from strawberry.schema.config import StrawberryConfig

from database import IndexedEndorsement, IndexedIdentity, SessionLocal


def _fix_double_encoded_utf8(text: str) -> str:
    """Repair a string that has been double-encoded (UTF-8 bytes treated as Latin-1).

    Double-encoding manifest as sequences like ``\\u00e5\\u00bc\\u0080``
    (each byte of a Chinese UTF-8 character misinterpreted as an ISO-8859-1
    code-point).  This function detects that pattern and recovers the original
    Unicode text.
    """
    if not text:
        return text
    # Quick heuristic: a double-encoded string is full of high Latin-1
    # code-points (U+0080–U+00FF) which are unlikely in normal text.
    try:
        repaired = text.encode("latin-1").decode("utf-8")
        # If we got here without error and the result looks *more* natural
        # (contains CJK or common scripts), return it.
        if repaired != text:
            return repaired
    except (UnicodeDecodeError, UnicodeEncodeError):
        pass
    return text


def _profile_view(identity: IndexedIdentity) -> dict:
    name = _fix_double_encoded_utf8(identity.display_name or "")
    metadata_text = _fix_double_encoded_utf8(identity.metadata_text or "")

    if identity.profile_json:
        try:
            parsed = json.loads(identity.profile_json)
            name = name or _fix_double_encoded_utf8(parsed.get("name") or "")
            metadata_text = metadata_text or _fix_double_encoded_utf8(parsed.get("metadata") or "")
        except json.JSONDecodeError:
            pass

    return {
        "name": name or identity.address[:10],
        "metadata": metadata_text,
    }


@strawberry.type
class GraphNode:
    address: str
    ipfs_cid: str = strawberry.field(name="ipfsCid")
    name: str
    metadata: str
    registered_at: str = strawberry.field(name="registeredAt")
    in_degree: int = strawberry.field(name="inDegree")
    out_degree: int = strawberry.field(name="outDegree")
    total_score: str = strawberry.field(name="totalScore")


@strawberry.type
class GraphEdge:
    from_address: str = strawberry.field(name="fromAddress")
    to_address: str = strawberry.field(name="toAddress")
    relation_type: int = strawberry.field(name="relationType")
    relation_label: str = strawberry.field(name="relationLabel")
    proof_hash: str = strawberry.field(name="proofHash")
    created_at: str = strawberry.field(name="createdAt")


@strawberry.type
class GraphStats:
    total_nodes: int = strawberry.field(name="totalNodes")
    total_edges: int = strawberry.field(name="totalEdges")
    max_in_degree: int = strawberry.field(name="maxInDegree")
    max_out_degree: int = strawberry.field(name="maxOutDegree")
    highest_score_node: Optional[str] = strawberry.field(name="highestScoreNode")


@strawberry.type
class KnowledgeGraph:
    nodes: list[GraphNode]
    edges: list[GraphEdge]
    stats: GraphStats


def _build_graph(
    relation_type: Optional[int] = None,
    address: Optional[str] = None,
) -> dict:
    """构建图数据，支持按关系类型和地址过滤。"""
    db = SessionLocal()
    try:
        identities_query = db.query(IndexedIdentity).order_by(IndexedIdentity.registered_at.asc())
        endorsements_query = db.query(IndexedEndorsement).order_by(IndexedEndorsement.created_at.asc())

        if relation_type is not None:
            endorsements_query = endorsements_query.filter(
                IndexedEndorsement.relation_type == relation_type
            )

        if address:
            # 过滤涉及指定地址的边
            endorsements_query = endorsements_query.filter(
                (IndexedEndorsement.from_address == address)
                | (IndexedEndorsement.to_address == address)
            )

        identities = identities_query.all()
        endorsements = endorsements_query.all()

        nodes = []
        max_in_degree = 0
        max_out_degree = 0
        highest_score = -1
        highest_score_node = None

        for identity in identities:
            in_degree = identity.in_degree or 0
            out_degree = identity.out_degree or 0
            total_score = in_degree
            profile = _profile_view(identity)

            max_in_degree = max(max_in_degree, in_degree)
            max_out_degree = max(max_out_degree, out_degree)
            if total_score > highest_score:
                highest_score = total_score
                highest_score_node = identity.address

            nodes.append(
                GraphNode(
                    address=identity.address,
                    ipfs_cid=identity.ipfs_cid,
                    name=profile["name"],
                    metadata=profile["metadata"],
                    registered_at=identity.registered_at.isoformat(),
                    in_degree=in_degree,
                    out_degree=out_degree,
                    total_score=str(total_score),
                )
            )

        edges = [
            GraphEdge(
                from_address=endorsement.from_address,
                to_address=endorsement.to_address,
                relation_type=endorsement.relation_type,
                relation_label=endorsement.relation_label,
                proof_hash=endorsement.proof_hash,
                created_at=endorsement.created_at.isoformat(),
            )
            for endorsement in endorsements
        ]

        stats = GraphStats(
            total_nodes=len(nodes),
            total_edges=len(edges),
            max_in_degree=max_in_degree,
            max_out_degree=max_out_degree,
            highest_score_node=highest_score_node,
        )

        return {"nodes": nodes, "edges": edges, "stats": stats}
    finally:
        db.close()


@strawberry.type
class Query:
    @strawberry.field
    def knowledge_graph(
        self,
        relation_type: Optional[int] = None,
        address: Optional[str] = None,
    ) -> KnowledgeGraph:
        data = _build_graph(relation_type=relation_type, address=address)
        return KnowledgeGraph(
            nodes=data["nodes"],
            edges=data["edges"],
            stats=data["stats"],
        )

    @strawberry.field
    def graph_stats(self) -> GraphStats:
        data = _build_graph()
        return data["stats"]


schema = strawberry.Schema(query=Query, config=StrawberryConfig(auto_camel_case=True))


# 保留旧版兼容函数供非 GraphQL 调用使用
def build_knowledge_graph_payload():
    data = _build_graph()
    return {
        "nodes": [
            {
                "address": n.address,
                "ipfsCid": n.ipfs_cid,
                "name": n.name,
                "metadata": n.metadata,
                "registeredAt": n.registered_at,
                "inDegree": n.in_degree,
                "outDegree": n.out_degree,
                "totalScore": n.total_score,
            }
            for n in data["nodes"]
        ],
        "edges": [
            {
                "fromAddress": e.from_address,
                "toAddress": e.to_address,
                "relationType": e.relation_type,
                "relationLabel": e.relation_label,
                "proofHash": e.proof_hash,
                "createdAt": e.created_at,
            }
            for e in data["edges"]
        ],
        "stats": {
            "totalNodes": data["stats"].total_nodes,
            "totalEdges": data["stats"].total_edges,
            "maxInDegree": data["stats"].max_in_degree,
            "maxOutDegree": data["stats"].max_out_degree,
            "highestScoreNode": data["stats"].highest_score_node,
        },
    }


def build_graph_stats_payload():
    return build_knowledge_graph_payload()["stats"]
