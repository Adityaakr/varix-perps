#![no_std]

use sails_rs::{
    cell::RefCell,
    collections::BTreeMap,
    gstd::{exec, msg},
    prelude::*,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct SessionPermissions {
    pub trade: bool,
    pub add_margin: bool,
    pub withdraw: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum SessionAction {
    Trade,
    AddMargin,
    Withdraw,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct SessionRecord {
    pub owner: ActorId,
    pub session_key: ActorId,
    pub expires_at: u32,
    pub permissions: SessionPermissions,
    pub registered_at: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum SessionError {
    InvalidExpiry,
    SessionInUse,
    SessionNotFound,
    Unauthorized,
}

#[sails_rs::event]
#[derive(Clone, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum SessionEvent {
    SessionRegistered {
        owner: ActorId,
        session_key: ActorId,
        expires_at: u32,
    },
    SessionRevoked {
        owner: ActorId,
        session_key: ActorId,
    },
}

#[derive(Default)]
pub struct SessionRegistryState {
    owner_sessions: BTreeMap<ActorId, SessionRecord>,
    session_owners: BTreeMap<ActorId, ActorId>,
}

pub struct SessionRegistryService<'a> {
    state: &'a RefCell<SessionRegistryState>,
}

impl<'a> SessionRegistryService<'a> {
    pub fn new(state: &'a RefCell<SessionRegistryState>) -> Self {
        Self { state }
    }

    fn current_block() -> u32 {
        exec::block_height()
    }

    fn is_expired(record: &SessionRecord, current_block: u32) -> bool {
        current_block >= record.expires_at
    }

    fn permission_allows(permissions: SessionPermissions, action: SessionAction) -> bool {
        match action {
            SessionAction::Trade => permissions.trade,
            SessionAction::AddMargin => permissions.add_margin,
            SessionAction::Withdraw => permissions.withdraw,
        }
    }
}

#[sails_rs::service(events = SessionEvent)]
impl SessionRegistryService<'_> {
    #[export(unwrap_result)]
    pub fn register_session(
        &mut self,
        session_key: ActorId,
        expires_at: u32,
        permissions: SessionPermissions,
    ) -> Result<SessionRecord, SessionError> {
        let owner = msg::source();
        let current_block = SessionRegistryService::current_block();
        if expires_at <= current_block {
            return Err(SessionError::InvalidExpiry);
        }

        let mut state = self.state.borrow_mut();
        if let Some(existing_owner) = state.session_owners.get(&session_key).copied()
            && existing_owner != owner
        {
            return Err(SessionError::SessionInUse);
        }

        if let Some(previous) = state.owner_sessions.insert(
            owner,
            SessionRecord {
                owner,
                session_key,
                expires_at,
                permissions,
                registered_at: current_block,
            },
        ) {
            state.session_owners.remove(&previous.session_key);
        }

        state.session_owners.insert(session_key, owner);
        let record = state
            .owner_sessions
            .get(&owner)
            .copied()
            .ok_or(SessionError::SessionNotFound)?;

        self.emit_event(SessionEvent::SessionRegistered {
            owner,
            session_key,
            expires_at,
        })
        .expect("event emission should succeed");
        Ok(record)
    }

    #[export(unwrap_result)]
    pub fn revoke_session(&mut self, session_key: ActorId) -> Result<bool, SessionError> {
        let owner = msg::source();
        let mut state = self.state.borrow_mut();
        let record = state
            .owner_sessions
            .get(&owner)
            .copied()
            .ok_or(SessionError::SessionNotFound)?;
        if record.session_key != session_key {
            return Err(SessionError::Unauthorized);
        }

        state.owner_sessions.remove(&owner);
        state.session_owners.remove(&session_key);
        self.emit_event(SessionEvent::SessionRevoked { owner, session_key })
            .expect("event emission should succeed");
        Ok(true)
    }

    #[export]
    pub fn active_session(&self, owner: ActorId) -> Option<SessionRecord> {
        let current_block = SessionRegistryService::current_block();
        self.state
            .borrow()
            .owner_sessions
            .get(&owner)
            .copied()
            .filter(|record| !SessionRegistryService::is_expired(record, current_block))
    }

    #[export]
    pub fn owner_for(&self, session_key: ActorId) -> Option<ActorId> {
        let current_block = SessionRegistryService::current_block();
        let state = self.state.borrow();
        let owner = state.session_owners.get(&session_key).copied()?;
        let record = state.owner_sessions.get(&owner)?;
        (!SessionRegistryService::is_expired(record, current_block)).then_some(owner)
    }

    #[export]
    pub fn validate(
        &self,
        owner: ActorId,
        session_key: ActorId,
        action: SessionAction,
    ) -> bool {
        let current_block = SessionRegistryService::current_block();
        self.state
            .borrow()
            .owner_sessions
            .get(&owner)
            .copied()
            .filter(|record| !SessionRegistryService::is_expired(record, current_block))
            .filter(|record| record.session_key == session_key)
            .map(|record| SessionRegistryService::permission_allows(record.permissions, action))
            .unwrap_or(false)
    }
}

pub struct Program {
    state: RefCell<SessionRegistryState>,
}

#[sails_rs::program]
impl Program {
    pub fn new() -> Self {
        Self {
            state: RefCell::new(SessionRegistryState::default()),
        }
    }

    pub fn session_registry(&self) -> SessionRegistryService<'_> {
        SessionRegistryService::new(&self.state)
    }
}
