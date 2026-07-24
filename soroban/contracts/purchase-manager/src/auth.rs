use crate::PurchaseError;
use soroban_sdk::{contracttype, Address, Env};

#[contracttype]
#[derive(Clone)]
pub enum AuthDataKey {
    AdminRole(Address),
}

pub fn has_admin_role(env: &Env, admin: &Address) -> bool {
    env.storage()
        .persistent()
        .has(&AuthDataKey::AdminRole(admin.clone()))
}

pub fn set_admin_role(env: &Env, admin: &Address) {
    env.storage()
        .persistent()
        .set(&AuthDataKey::AdminRole(admin.clone()), &true);
}

pub fn remove_admin_role(env: &Env, admin: &Address) {
    env.storage()
        .persistent()
        .remove(&AuthDataKey::AdminRole(admin.clone()));
}

pub fn require_admin(env: &Env, caller: &Address) -> Result<(), PurchaseError> {
    caller.require_auth();
    if !has_admin_role(env, caller) {
        return Err(PurchaseError::NotAuthorized);
    }
    Ok(())
}
