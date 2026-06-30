use crate::{
    web4::types::{Web4Request, Web4Response},
    Contract
};

pub fn web4_get(_contract: &Contract, _request: Web4Request) -> Web4Response {
    // Serve the frontend bundle from the gateway (which serves the same bundle at
    // its root), so frontend updates only require redeploying the gateway — not the
    // contract. The SAB-free OPFS build needs no special headers, so it's fine that
    // web4 serves the gateway's bundle. A fixed body_url for every path lets the SPA
    // router handle client routes (/portfolio, /year-report, ...).
    Web4Response::BodyUrl {
        body_url: String::from("https://arizgateway.fly.dev/"),
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {}
