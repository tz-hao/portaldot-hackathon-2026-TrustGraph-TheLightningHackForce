



from sqlalchemy import Column, DateTime, Integer, String, Text, UniqueConstraint, create_engine
from sqlalchemy.orm import declarative_base, sessionmaker
from datetime import datetime
import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

DEFAULT_DB_PATH = Path(__file__).resolve().with_name("trustgraph.db")
DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite:///{DEFAULT_DB_PATH.as_posix()}")

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class IndexedIdentity(Base):
    __tablename__ = "indexed_identities"

    id = Column(Integer, primary_key=True, index=True)
    address = Column(String, unique=True, index=True)
    ipfs_cid = Column(String, nullable=False)
    display_name = Column(String, nullable=True)
    metadata_text = Column(Text, nullable=True)
    profile_json = Column(Text, nullable=True)
    registered_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    block_number = Column(Integer, nullable=False, index=True)
    extrinsic_hash = Column(String, nullable=True)
    in_degree = Column(Integer, nullable=False, default=0)
    out_degree = Column(Integer, nullable=False, default=0)


class IndexedEndorsement(Base):
    __tablename__ = "indexed_endorsements"
    __table_args__ = (
        UniqueConstraint("from_address", "to_address", name="uq_indexed_endorsements_pair"),
    )

    id = Column(Integer, primary_key=True, index=True)
    from_address = Column(String, nullable=False, index=True)
    to_address = Column(String, nullable=False, index=True)
    relation_type = Column(Integer, nullable=False)
    relation_label = Column(String, nullable=False)
    proof_hash = Column(String, nullable=False)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    block_number = Column(Integer, nullable=False, index=True)
    extrinsic_hash = Column(String, nullable=True)


class SyncState(Base):
    __tablename__ = "indexer_sync_state"

    id = Column(Integer, primary_key=True, default=1)
    last_processed_block = Column(Integer, nullable=False, default=0)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)


class IdentityIpfsMigration(Base):
    __tablename__ = "identity_ipfs_migrations"
    __table_args__ = (
        UniqueConstraint("address", "source_value", name="uq_identity_ipfs_migration_source"),
    )

    id = Column(Integer, primary_key=True, index=True)
    address = Column(String, nullable=False, index=True)
    source_value = Column(Text, nullable=False)
    migrated_cid = Column(String, nullable=False, index=True)
    profile_json = Column(Text, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)


def init_db():
    Base.metadata.create_all(bind=engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


init_db()
