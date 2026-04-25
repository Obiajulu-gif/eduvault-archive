#![no_std]

use soroban_sdk::xdr::ToXdr;
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, BytesN, Env,
    String, Vec,
};

const BASIS_POINTS: u32 = 10_000;
const MAX_METADATA_URI_LEN: u32 = 256;
const MAX_QUOTES_PER_MATERIAL: u32 = 4;
const MAX_PAYOUT_RECIPIENTS: u32 = 5;

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MaterialStatus {
    Active = 0,
    Paused = 1,
    Archived = 2,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetQuote {
    pub asset: Address,
    pub amount: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PayoutShare {
    pub recipient: Address,
    pub share_bps: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaterialRecord {
    pub material_id: BytesN<32>,
    pub creator: Address,
    pub metadata_uri: String,
    pub metadata_hash: BytesN<32>,
    pub rights_hash: BytesN<32>,
    pub status: MaterialStatus,
    pub quotes: Vec<AssetQuote>,
    pub payout_shares: Vec<PayoutShare>,
    pub created_ledger: u32,
    pub updated_ledger: u32,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    CreatorNonce(Address),
    Material(BytesN<32>),
}

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum RegistryError {
    EmptyMetadataUri = 1,
    MetadataUriTooLong = 2,
    EmptyQuotes = 3,
    TooManyQuotes = 4,
    DuplicateQuoteAsset = 5,
    InvalidQuoteAmount = 6,
    EmptyPayoutShares = 7,
    TooManyPayoutShares = 8,
    DuplicatePayoutRecipient = 9,
    InvalidPayoutShare = 10,
    InvalidPayoutShareSum = 11,
    MaterialAlreadyExists = 12,
    MaterialNotFound = 13,
}

#[contractevent(topics = ["material", "registered"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaterialRegisteredEvent {
    #[topic]
    pub material_id: BytesN<32>,
    #[topic]
    pub creator: Address,
    pub metadata_uri: String,
    pub metadata_hash: BytesN<32>,
    pub rights_hash: BytesN<32>,
    pub status: MaterialStatus,
    pub quotes: Vec<AssetQuote>,
    pub payout_shares: Vec<PayoutShare>,
}

#[contractevent(topics = ["material", "sale_terms_updated"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaterialSaleTermsUpdatedEvent {
    #[topic]
    pub material_id: BytesN<32>,
    #[topic]
    pub creator: Address,
    pub status: MaterialStatus,
    pub quotes: Vec<AssetQuote>,
    pub payout_shares: Vec<PayoutShare>,
}

#[contractevent(topics = ["material", "status_updated"], data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaterialStatusUpdatedEvent {
    #[topic]
    pub material_id: BytesN<32>,
    #[topic]
    pub creator: Address,
    pub status: MaterialStatus,
}

#[contract]
pub struct MaterialRegistry;

#[contractimpl]
impl MaterialRegistry {
    pub fn register_material(
        env: Env,
        creator: Address,
        metadata_uri: String,
        metadata_hash: BytesN<32>,
        rights_hash: BytesN<32>,
        quotes: Vec<AssetQuote>,
        payout_shares: Vec<PayoutShare>,
    ) -> Result<BytesN<32>, RegistryError> {
        creator.require_auth();
        validate_metadata_uri(&metadata_uri)?;
        validate_quotes(&quotes)?;
        validate_payout_shares(&payout_shares)?;

        let next_nonce = get_creator_nonce(&env, &creator);
        let material_id = derive_material_id(&env, &creator, next_nonce);
        if has_material(&env, &material_id) {
            return Err(RegistryError::MaterialAlreadyExists);
        }

        let current_ledger = env.ledger().sequence();
        let record = MaterialRecord {
            material_id: material_id.clone(),
            creator: creator.clone(),
            metadata_uri: metadata_uri.clone(),
            metadata_hash: metadata_hash.clone(),
            rights_hash: rights_hash.clone(),
            status: MaterialStatus::Active,
            quotes: quotes.clone(),
            payout_shares: payout_shares.clone(),
            created_ledger: current_ledger,
            updated_ledger: current_ledger,
        };
        put_material(&env, &record);
        set_creator_nonce(&env, &creator, next_nonce + 1);

        MaterialRegisteredEvent {
            material_id: material_id.clone(),
            creator,
            metadata_uri,
            metadata_hash,
            rights_hash,
            status: MaterialStatus::Active,
            quotes,
            payout_shares,
        }
        .publish(&env);

        Ok(material_id)
    }

    pub fn update_sale_terms(
        env: Env,
        material_id: BytesN<32>,
        quotes: Vec<AssetQuote>,
        payout_shares: Vec<PayoutShare>,
    ) -> Result<(), RegistryError> {
        validate_quotes(&quotes)?;
        validate_payout_shares(&payout_shares)?;

        let mut record = get_material_record(&env, &material_id)?;
        record.creator.require_auth();
        record.quotes = quotes.clone();
        record.payout_shares = payout_shares.clone();
        record.updated_ledger = env.ledger().sequence();

        put_material(&env, &record);

        MaterialSaleTermsUpdatedEvent {
            material_id,
            creator: record.creator,
            status: record.status,
            quotes,
            payout_shares,
        }
        .publish(&env);

        Ok(())
    }

    pub fn set_material_status(
        env: Env,
        material_id: BytesN<32>,
        status: MaterialStatus,
    ) -> Result<(), RegistryError> {
        let mut record = get_material_record(&env, &material_id)?;
        record.creator.require_auth();

        if record.status == status {
            return Ok(());
        }

        record.status = status;
        record.updated_ledger = env.ledger().sequence();
        put_material(&env, &record);

        MaterialStatusUpdatedEvent {
            material_id,
            creator: record.creator,
            status,
        }
        .publish(&env);

        Ok(())
    }

    pub fn get_material(env: Env, material_id: BytesN<32>) -> Result<MaterialRecord, RegistryError> {
        get_material_record(&env, &material_id)
    }

    pub fn get_quote(
        env: Env,
        material_id: BytesN<32>,
        asset: Address,
    ) -> Result<Option<AssetQuote>, RegistryError> {
        let record = get_material_record(&env, &material_id)?;
        let mut index = 0;
        while index < record.quotes.len() {
            let quote = record.quotes.get_unchecked(index);
            if quote.asset == asset {
                return Ok(Some(quote));
            }
            index += 1;
        }

        Ok(None)
    }
}

fn validate_metadata_uri(metadata_uri: &String) -> Result<(), RegistryError> {
    let byte_len = metadata_uri.to_bytes().len();
    if byte_len == 0 {
        return Err(RegistryError::EmptyMetadataUri);
    }
    if byte_len > MAX_METADATA_URI_LEN {
        return Err(RegistryError::MetadataUriTooLong);
    }
    Ok(())
}

fn validate_quotes(quotes: &Vec<AssetQuote>) -> Result<(), RegistryError> {
    let len = quotes.len();
    if len == 0 {
        return Err(RegistryError::EmptyQuotes);
    }
    if len > MAX_QUOTES_PER_MATERIAL {
        return Err(RegistryError::TooManyQuotes);
    }

    let mut index = 0;
    while index < len {
        let quote = quotes.get_unchecked(index);
        if quote.amount <= 0 {
            return Err(RegistryError::InvalidQuoteAmount);
        }

        let mut other = index + 1;
        while other < len {
            if quote.asset == quotes.get_unchecked(other).asset {
                return Err(RegistryError::DuplicateQuoteAsset);
            }
            other += 1;
        }

        index += 1;
    }

    Ok(())
}

fn validate_payout_shares(payout_shares: &Vec<PayoutShare>) -> Result<(), RegistryError> {
    let len = payout_shares.len();
    if len == 0 {
        return Err(RegistryError::EmptyPayoutShares);
    }
    if len > MAX_PAYOUT_RECIPIENTS {
        return Err(RegistryError::TooManyPayoutShares);
    }

    let mut total_share_bps = 0u32;
    let mut index = 0;
    while index < len {
        let share = payout_shares.get_unchecked(index);
        if share.share_bps == 0 {
            return Err(RegistryError::InvalidPayoutShare);
        }

        total_share_bps += share.share_bps;

        let mut other = index + 1;
        while other < len {
            if share.recipient == payout_shares.get_unchecked(other).recipient {
                return Err(RegistryError::DuplicatePayoutRecipient);
            }
            other += 1;
        }

        index += 1;
    }

    if total_share_bps != BASIS_POINTS {
        return Err(RegistryError::InvalidPayoutShareSum);
    }

    Ok(())
}

fn derive_material_id(env: &Env, creator: &Address, nonce: u64) -> BytesN<32> {
    let mut seed = creator.to_xdr(env);
    seed.append(&nonce.to_xdr(env));
    env.crypto().sha256(&seed).to_bytes()
}

fn get_creator_nonce(env: &Env, creator: &Address) -> u64 {
    env.storage()
        .persistent()
        .get(&DataKey::CreatorNonce(creator.clone()))
        .unwrap_or(0)
}

fn set_creator_nonce(env: &Env, creator: &Address, nonce: u64) {
    env.storage()
        .persistent()
        .set(&DataKey::CreatorNonce(creator.clone()), &nonce);
}

fn has_material(env: &Env, material_id: &BytesN<32>) -> bool {
    env.storage()
        .persistent()
        .has(&DataKey::Material(material_id.clone()))
}

fn get_material_record(env: &Env, material_id: &BytesN<32>) -> Result<MaterialRecord, RegistryError> {
    env.storage()
        .persistent()
        .get(&DataKey::Material(material_id.clone()))
        .ok_or(RegistryError::MaterialNotFound)
}

fn put_material(env: &Env, record: &MaterialRecord) {
    env.storage()
        .persistent()
        .set(&DataKey::Material(record.material_id.clone()), record);
}

#[cfg(test)]
mod test;
