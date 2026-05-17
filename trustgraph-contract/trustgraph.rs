#![cfg_attr(not(feature = "std"), no_std, no_main)]

#[ink::contract]
pub mod trustgraph {
    use ink::prelude::string::String;
    use ink::storage::Mapping;

    /// 用户的 SBT 身份配置
    #[derive(Debug, Clone, PartialEq, Eq, scale::Decode, scale::Encode)]
    #[cfg_attr(
        feature = "std",
        derive(scale_info::TypeInfo, ink::storage::traits::StorageLayout)
    )]
    pub struct Profile {
        pub ipfs_cid: String,
    }

    /// 背书关系边，保留链下索引器构图所需的核心语义
    #[derive(Debug, Clone, PartialEq, Eq, scale::Decode, scale::Encode)]
    #[cfg_attr(
        feature = "std",
        derive(scale_info::TypeInfo, ink::storage::traits::StorageLayout)
    )]
    pub struct Endorsement {
        /// 关系类型，由应用层约定枚举值
        pub relation_type: u8,
        /// 轻量级 ZK/关系证明摘要
        pub proof_hash: Hash,
        /// 背书建立时间
        pub created_at: Timestamp,
    }

    /// 合约自定义错误类型
    #[derive(Debug, PartialEq, Eq, scale::Encode, scale::Decode)]
    #[cfg_attr(feature = "std", derive(scale_info::TypeInfo))]
    pub enum Error {
        AlreadyRegistered,
        IdentityNotRegistered,
        TargetNotRegistered,
        SelfEndorsement,
        AlreadyEndorsed,
    }

    /// 返回结果类型
    pub type Result<T> = core::result::Result<T, Error>;

    /// 身份注册事件
    #[ink(event)]
    pub struct IdentityMinted {
        #[ink(topic)]
        pub owner: AccountId,
        pub cid: String,
    }

    /// 背书关系建立事件
    #[ink(event)]
    pub struct EndorsementCreated {
        #[ink(topic)]
        pub from: AccountId,
        #[ink(topic)]
        pub to: AccountId,
        pub relation_type: u8,
        pub proof_hash: Hash,
        pub created_at: Timestamp,
    }

    #[ink(storage)]
    pub struct Trustgraph {
        /// 身份 (SBT)：使用 Mapping 将用户的 AccountId 映射到 Profile
        profiles: Mapping<AccountId, Profile>,
        /// 背书关系：记录信任连线，从一个 AccountId 到另一个 AccountId 的映射
        endorsements: Mapping<(AccountId, AccountId), Endorsement>,
    }

    impl Default for Trustgraph {
        fn default() -> Self {
            Self::new()
        }
    }

    impl Trustgraph {
        /// 构造函数。POT 的消耗交由链级 gas 负责，合约不再额外收取业务费。
        #[ink(constructor)]
        pub fn new() -> Self {
            Self {
                profiles: Mapping::default(),
                endorsements: Mapping::default(),
            }
        }

        /// 获取指定账户的身份信息
        #[ink(message)]
        pub fn get_profile(&self, owner: AccountId) -> Option<Profile> {
            self.profiles.get(owner)
        }

        /// 获取指定背书关系
        #[ink(message)]
        pub fn get_endorsement(&self, from: AccountId, to: AccountId) -> Option<Endorsement> {
            self.endorsements.get((from, to))
        }

        /// 判断指定账户是否已注册身份
        #[ink(message)]
        pub fn is_registered(&self, owner: AccountId) -> bool {
            self.profiles.contains(owner)
        }

        /// 判断指定方向的背书关系是否存在
        #[ink(message)]
        pub fn has_endorsement(&self, from: AccountId, to: AccountId) -> bool {
            self.endorsements.contains((from, to))
        }

        /// 注册身份 (SBT)
        #[ink(message)]
        pub fn register_identity(&mut self, cid: String) -> Result<()> {
            let caller = self.env().caller();

            if self.profiles.contains(caller) {
                return Err(Error::AlreadyRegistered);
            }

            let profile = Profile {
                ipfs_cid: cid.clone(),
            };
            self.profiles.insert(caller, &profile);

            self.env().emit_event(IdentityMinted {
                owner: caller,
                cid,
            });

            Ok(())
        }

        /// 发起背书
        #[ink(message)]
        pub fn endorse(&mut self, target: AccountId, relation_type: u8, proof_hash: Hash) -> Result<()> {
            let caller = self.env().caller();

            if caller == target {
                return Err(Error::SelfEndorsement);
            }

            if !self.profiles.contains(caller) {
                return Err(Error::IdentityNotRegistered);
            }

            if !self.profiles.contains(target) {
                return Err(Error::TargetNotRegistered);
            }

            if self.endorsements.contains((caller, target)) {
                return Err(Error::AlreadyEndorsed);
            }

            let endorsement = Endorsement {
                relation_type,
                proof_hash,
                created_at: self.env().block_timestamp(),
            };
            self.endorsements.insert((caller, target), &endorsement);

            self.env().emit_event(EndorsementCreated {
                from: caller,
                to: target,
                relation_type,
                proof_hash,
                created_at: endorsement.created_at,
            });

            Ok(())
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn sample_hash(byte: u8) -> Hash {
            Hash::from([byte; 32])
        }

        #[ink::test]
        fn constructor_works() {
            let contract = Trustgraph::new();
            let accounts = ink::env::test::default_accounts::<ink::env::DefaultEnvironment>();

            assert_eq!(contract.get_profile(accounts.alice), None);
            assert_eq!(contract.get_endorsement(accounts.alice, accounts.bob), None);
        }

        #[ink::test]
        fn register_identity_works() {
            let mut contract = Trustgraph::new();
            let accounts = ink::env::test::default_accounts::<ink::env::DefaultEnvironment>();

            ink::env::test::set_caller::<ink::env::DefaultEnvironment>(accounts.alice);

            let cid = String::from("QmTest123");
            let result = contract.register_identity(cid);
            assert_eq!(result, Ok(()));

            let result2 = contract.register_identity(String::from("QmTest456"));
            assert_eq!(result2, Err(Error::AlreadyRegistered));
        }

        #[ink::test]
        fn endorse_works() {
            let mut contract = Trustgraph::new();
            let accounts = ink::env::test::default_accounts::<ink::env::DefaultEnvironment>();
            let relation_type = 1_u8;
            let proof_hash = sample_hash(7);
            let endorsement_timestamp = 1_234_u64;

            ink::env::test::set_caller::<ink::env::DefaultEnvironment>(accounts.alice);
            assert_eq!(contract.register_identity(String::from("CID_A")), Ok(()));

            ink::env::test::set_caller::<ink::env::DefaultEnvironment>(accounts.bob);
            assert_eq!(contract.register_identity(String::from("CID_B")), Ok(()));

            ink::env::test::set_block_timestamp::<ink::env::DefaultEnvironment>(endorsement_timestamp);
            ink::env::test::set_caller::<ink::env::DefaultEnvironment>(accounts.alice);
            assert_eq!(contract.endorse(accounts.bob, relation_type, proof_hash), Ok(()));

            assert_eq!(
                contract.endorse(accounts.charlie, relation_type, sample_hash(8)),
                Err(Error::TargetNotRegistered)
            );

            assert_eq!(
                contract.get_endorsement(accounts.alice, accounts.bob),
                Some(Endorsement {
                    relation_type,
                    proof_hash,
                    created_at: endorsement_timestamp,
                })
            );
        }

        #[ink::test]
        fn endorse_fails_if_not_registered() {
            let mut contract = Trustgraph::new();
            let accounts = ink::env::test::default_accounts::<ink::env::DefaultEnvironment>();

            ink::env::test::set_caller::<ink::env::DefaultEnvironment>(accounts.alice);
            assert_eq!(
                contract.endorse(accounts.bob, 1, sample_hash(1)),
                Err(Error::IdentityNotRegistered)
            );
        }

        #[ink::test]
        fn endorse_fails_if_relation_already_exists() {
            let mut contract = Trustgraph::new();
            let accounts = ink::env::test::default_accounts::<ink::env::DefaultEnvironment>();
            let first_hash = sample_hash(1);
            let second_hash = sample_hash(2);

            ink::env::test::set_caller::<ink::env::DefaultEnvironment>(accounts.alice);
            assert_eq!(contract.register_identity(String::from("CID_A")), Ok(()));

            ink::env::test::set_caller::<ink::env::DefaultEnvironment>(accounts.bob);
            assert_eq!(contract.register_identity(String::from("CID_B")), Ok(()));

            ink::env::test::set_block_timestamp::<ink::env::DefaultEnvironment>(100);
            ink::env::test::set_caller::<ink::env::DefaultEnvironment>(accounts.alice);
            assert_eq!(contract.endorse(accounts.bob, 1, first_hash), Ok(()));

            ink::env::test::set_block_timestamp::<ink::env::DefaultEnvironment>(200);
            assert_eq!(
                contract.endorse(accounts.bob, 2, second_hash),
                Err(Error::AlreadyEndorsed)
            );

            assert_eq!(
                contract.get_endorsement(accounts.alice, accounts.bob),
                Some(Endorsement {
                    relation_type: 1,
                    proof_hash: first_hash,
                    created_at: 100,
                })
            );
        }

        #[ink::test]
        fn get_profile_returns_none_for_unregistered_account() {
            let contract = Trustgraph::new();
            let accounts = ink::env::test::default_accounts::<ink::env::DefaultEnvironment>();

            assert_eq!(contract.get_profile(accounts.alice), None);
            assert!(!contract.is_registered(accounts.alice));
        }

        #[ink::test]
        fn get_profile_returns_registered_profile() {
            let mut contract = Trustgraph::new();
            let accounts = ink::env::test::default_accounts::<ink::env::DefaultEnvironment>();
            let cid = String::from("QmAliceResumeCid");

            ink::env::test::set_caller::<ink::env::DefaultEnvironment>(accounts.alice);

            assert_eq!(contract.register_identity(cid.clone()), Ok(()));
            assert_eq!(
                contract.get_profile(accounts.alice),
                Some(Profile { ipfs_cid: cid })
            );
            assert!(contract.is_registered(accounts.alice));
            assert!(!contract.is_registered(accounts.bob));
            assert_eq!(contract.get_profile(accounts.bob), None);
        }

        #[ink::test]
        fn get_endorsement_returns_none_when_edge_does_not_exist() {
            let contract = Trustgraph::new();
            let accounts = ink::env::test::default_accounts::<ink::env::DefaultEnvironment>();

            assert_eq!(contract.get_endorsement(accounts.alice, accounts.bob), None);
            assert_eq!(contract.get_endorsement(accounts.bob, accounts.alice), None);
            assert!(!contract.has_endorsement(accounts.alice, accounts.bob));
            assert!(!contract.has_endorsement(accounts.bob, accounts.alice));
        }

        #[ink::test]
        fn get_endorsement_returns_struct_for_existing_edge_only() {
            let mut contract = Trustgraph::new();
            let accounts = ink::env::test::default_accounts::<ink::env::DefaultEnvironment>();
            let endorsement_timestamp = 1_234_u64;
            let relation_type = 3_u8;
            let proof_hash = sample_hash(9);

            ink::env::test::set_caller::<ink::env::DefaultEnvironment>(accounts.alice);
            assert_eq!(contract.register_identity(String::from("CID_A")), Ok(()));

            ink::env::test::set_caller::<ink::env::DefaultEnvironment>(accounts.bob);
            assert_eq!(contract.register_identity(String::from("CID_B")), Ok(()));

            ink::env::test::set_block_timestamp::<ink::env::DefaultEnvironment>(endorsement_timestamp);
            ink::env::test::set_caller::<ink::env::DefaultEnvironment>(accounts.alice);
            assert_eq!(contract.endorse(accounts.bob, relation_type, proof_hash), Ok(()));

            assert_eq!(
                contract.get_endorsement(accounts.alice, accounts.bob),
                Some(Endorsement {
                    relation_type,
                    proof_hash,
                    created_at: endorsement_timestamp,
                })
            );
            assert!(contract.has_endorsement(accounts.alice, accounts.bob));
            assert!(!contract.has_endorsement(accounts.bob, accounts.alice));
            assert_eq!(contract.get_endorsement(accounts.bob, accounts.alice), None);
            assert_eq!(contract.get_endorsement(accounts.alice, accounts.charlie), None);
        }
    }
}
