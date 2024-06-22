use crate::{
    web4::types::{Web4Request, Web4Response},
    Contract
};

pub fn web4_get(_contract: &Contract, _request: Web4Request) -> Web4Response {
    Web4Response::BodyUrl { body_url: 
        String::from("https://ipfs.web4.near.page/ipfs/bafybeiaeppgoi5mcn2cw3qtn4cjllml4g5cdzmkzsr57dzgqhhchm336oa/")
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {}
