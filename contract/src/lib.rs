pub mod web4;

use near_sdk::borsh::{BorshDeserialize, BorshSerialize};

use near_sdk::store::LookupMap;
use near_sdk::{env, near_bindgen, AccountId, NearToken, PanicOnDefault};
use web4::types::{Web4Request, Web4Response};

#[derive(BorshDeserialize, BorshSerialize, PartialEq, Clone)]
#[borsh(crate = "near_sdk::borsh")]
pub enum Permission {
    Owner,
    Contributor,
    Reader,
}

#[near_bindgen]
#[derive(PanicOnDefault, BorshDeserialize, BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
pub struct Contract {
    tokens: LookupMap<Vec<u8>, AccountId>,
}

#[near_bindgen]
impl Contract {
    #[init(ignore_state)]
    pub fn init() -> Self {
        let contract = Self {
            tokens: LookupMap::new(b"t".to_vec()),
        };
        contract
    }

    fn internal_register_token(
        &mut self,
        token_hash: Vec<u8>,
        signature: Vec<u8>,
        public_key: Vec<u8>,
    ) {
        if token_hash.len() > 64 {
            env::panic_str("Token hashes larger than 64 bytes are not supported")
        }

        if !env::ed25519_verify(
            signature.as_slice().try_into().unwrap(),
            token_hash.as_slice(),
            public_key.as_slice().try_into().unwrap(),
        ) {
            env::panic_str("Invalid token signature");
        }
        self.tokens
            .insert(token_hash.to_vec(), env::signer_account_id());
    }

    #[payable]
    pub fn register_token(&mut self, token_hash: Vec<u8>, signature: Vec<u8>, public_key: Vec<u8>) {
        if env::attached_deposit() != NearToken::from_millinear(200) {
            env::panic_str("You must deposit 0.2 NEAR to register a token");
        }

        self.internal_register_token(token_hash, signature, public_key.to_vec());
    }

    pub fn replace_token(
        &mut self,
        old_token_hash: Vec<u8>,
        new_token_hash: Vec<u8>,
        signature: Vec<u8>,
    ) {
        let account_id_for_old_token_option = self.get_account_id_for_token(old_token_hash.clone());
        if account_id_for_old_token_option == None {
            env::panic_str("cannot replace unknown token");
        }
        let account_id_for_old_token = account_id_for_old_token_option.unwrap();
        if account_id_for_old_token != env::signer_account_id() {
            env::panic_str("old token does not belong to you");
        }

        let mut pk_array: [u8; 32] = [0u8; 32];
        pk_array.copy_from_slice(&env::signer_account_pk().as_bytes()[1..33].to_vec());

        self.internal_register_token(new_token_hash, signature, pk_array.to_vec());
        self.tokens.remove(&old_token_hash);
    }

    pub fn get_account_id_for_token(&self, token_hash: Vec<u8>) -> Option<String> {
        if let Some(account_id) = self.tokens.get(token_hash.as_slice()) {
            return Some(account_id.to_string());
        } else {
            return None;
        }
    }

    pub fn web4_get(&self, request: Web4Request) -> Web4Response {
        web4::handler::web4_get(self, request)
    }
}

#[cfg(test)]
pub mod tests {
    use env::sha256;
    use near_sdk::{
        test_utils::{accounts, VMContextBuilder},
        testing_env, CurveType, PublicKey,
    };

    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use rand::rngs::OsRng;

    #[test]
    fn test_unknown_token() {
        testing_env!(VMContextBuilder::new()
            .signer_account_id(accounts(0))
            .attached_deposit(NearToken::from_millinear(200))
            .build());

        let contract = Contract::init();
        let token = [0u8; 32].to_vec();
        assert_eq!(None, contract.get_account_id_for_token(token));
    }

    #[test]
    fn test_known_token() {
        let mut csprng = OsRng {};
        let signing_key = SigningKey::generate(&mut csprng);
        let verifying_key = signing_key.verifying_key();
        let public_key_bytes = verifying_key.as_bytes();
        let pk = PublicKey::from_parts(CurveType::ED25519, public_key_bytes.to_vec()).unwrap();

        testing_env!(VMContextBuilder::new()
            .signer_account_id(accounts(0))
            .signer_account_pk(pk)
            .attached_deposit(NearToken::from_millinear(200))
            .build());

        let mut contract = Contract::init();

        let token_hash = sha256("{\"id\": \"1\"}".as_bytes());
        let signature = signing_key.sign(&token_hash).to_vec();

        contract.register_token(token_hash.clone(), signature, public_key_bytes.to_vec());

        assert_eq!(
            accounts(0).to_string(),
            contract.get_account_id_for_token(token_hash).unwrap()
        );
    }

    #[test]
    fn test_replace_token() {
        let mut csprng = OsRng {};
        let signing_key = SigningKey::generate(&mut csprng);
        let verifying_key = signing_key.verifying_key();
        let public_key_bytes = verifying_key.to_bytes();
        let pk = PublicKey::from_parts(CurveType::ED25519, public_key_bytes.to_vec()).unwrap();

        testing_env!(VMContextBuilder::new()
            .signer_account_id(accounts(0))
            .signer_account_pk(pk.clone())
            .attached_deposit(NearToken::from_millinear(200))
            .build());

        let mut contract = Contract::init();

        let token_hash = sha256("{\"id\": \"1\"}".as_bytes());
        let signature = signing_key.sign(&token_hash).to_vec();

        contract.register_token(token_hash.clone(), signature, public_key_bytes.to_vec());

        assert_eq!(
            accounts(0).to_string(),
            contract
                .get_account_id_for_token(token_hash.clone())
                .unwrap()
        );

        let new_token_hash = sha256("{\"id\": \"2\"}".as_bytes());
        let new_signature = signing_key.sign(&new_token_hash).to_vec();

        contract.replace_token(token_hash.clone(), new_token_hash.clone(), new_signature);
        assert_eq!(None, contract.get_account_id_for_token(token_hash.clone()));

        assert_eq!(
            accounts(0).to_string(),
            contract
                .get_account_id_for_token(new_token_hash.clone())
                .unwrap()
        );
    }
}
