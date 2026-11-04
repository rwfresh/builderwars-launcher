//! `builderwars://run?prompt=...&agent=...` deep links (tauri-plugin-deep-link).
//!
//! Any web page can open a deep link, so a link never runs anything by itself: it is queued here
//! and the shell UI always asks for confirmation (same dialog as prompts from the site).
//! Links can arrive before the shell UI listens (cold start), hence the queue + `deeplink_take`.

use crate::bridge::{validate_agent, validate_prompt};
use crate::panes::SHELL;
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, Url, Webview};

pub const SCHEME: &str = "builderwars";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeepLinkRequest {
    pub prompt: String,
    pub agent: Option<String>,
}

#[derive(Default)]
pub struct DeepLinks(Mutex<Vec<DeepLinkRequest>>);

pub fn parse(url: &Url) -> Result<DeepLinkRequest, String> {
    if url.scheme() != SCHEME {
        return Err(format!("not a {SCHEME}:// link"));
    }
    // builderwars://run?... parses with host "run"; also accept builderwars:run?... / builderwars:///run?...
    let action = url
        .host_str()
        .filter(|h| !h.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| url.path().trim_matches('/').to_string());
    if action != "run" {
        return Err(format!("unknown deep link action {action:?}"));
    }
    let mut prompt = None;
    let mut agent = None;
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "prompt" => prompt = Some(v.into_owned()),
            "agent" if !v.is_empty() => agent = Some(v.into_owned()),
            _ => {}
        }
    }
    let prompt = prompt.ok_or("deep link without prompt")?;
    validate_prompt(&prompt)?;
    if let Some(a) = &agent {
        validate_agent(a)?;
    }
    Ok(DeepLinkRequest { prompt, agent })
}

pub fn handle_urls(app: &AppHandle, urls: Vec<Url>) {
    let mut queued = false;
    for url in urls {
        match parse(&url) {
            Ok(req) => {
                println!("[deeplink] queued run request ({} chars, agent={:?})", req.prompt.chars().count(), req.agent);
                app.state::<DeepLinks>().0.lock().unwrap().push(req);
                queued = true;
            }
            Err(e) => {
                eprintln!("[deeplink] ignored {}: {e}", url.scheme());
                let _ = app.emit_to(SHELL, "launcher:notice", format!("ignored deep link: {e}"));
            }
        }
    }
    if queued {
        let _ = app.emit_to(SHELL, "deeplink:pending", ());
        if let Some(w) = app.get_window("main") {
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    }
}

/// Shell-only: drain queued deep-link requests.
#[tauri::command]
pub fn deeplink_take(webview: Webview, links: State<'_, DeepLinks>) -> Result<Vec<DeepLinkRequest>, String> {
    crate::require_shell(&webview)?;
    Ok(std::mem::take(&mut *links.0.lock().unwrap()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> Result<DeepLinkRequest, String> {
        parse(&s.parse::<Url>().unwrap())
    }

    #[test]
    fn parses_run_links() {
        assert_eq!(
            p("builderwars://run?prompt=make%20a%20promo%20%22now%22&agent=codex").unwrap(),
            DeepLinkRequest { prompt: "make a promo \"now\"".into(), agent: Some("codex".into()) }
        );
        assert_eq!(p("builderwars:run?prompt=hi").unwrap().agent, None);
        assert_eq!(p("builderwars:///run?prompt=hi&agent=").unwrap().agent, None);
    }

    #[test]
    fn rejects_bad_links() {
        assert!(p("builderwars://run").is_err());
        assert!(p("builderwars://run?prompt=%20").is_err());
        assert!(p("builderwars://delete?prompt=x").is_err());
        assert!(p("builderwars://run?prompt=x&agent=rm%20-rf").is_err());
        assert!(p("https://run?prompt=x").is_err());
    }
}
