#![no_std]
#![allow(static_mut_refs)]

use sails_rs::prelude::*;

static mut COUNTER: i64 = 0;

#[derive(Default)]
pub struct CounterService;

#[sails_rs::service]
impl CounterService {
    #[export]
    pub fn increment(&mut self) -> i64 {
        unsafe {
            COUNTER += 1;
            COUNTER
        }
    }

    #[export]
    pub fn get(&self) -> i64 {
        unsafe { COUNTER }
    }
}

#[derive(Default)]
pub struct Program;

#[sails_rs::program]
impl Program {
    pub fn create() -> Self {
        unsafe {
            COUNTER = 0;
        }
        Self
    }

    pub fn counter(&self) -> CounterService {
        CounterService
    }
}
