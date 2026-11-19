//! Sockets and HTTP requests for the script's `platform.net`. Each WebSocket and each request
//! runs on its own thread; results queue up as events the host hands to the script once per
//! frame through `__blackiron.net(id, kind, data, code)`, so the script never blocks.

use std::collections::HashMap;
use std::io::{ErrorKind, Read};
use std::net::TcpStream;
use std::sync::mpsc::{channel, Receiver, Sender, TryRecvError};
use std::thread;
use std::time::Duration;

use tungstenite::protocol::frame::coding::CloseCode;
use tungstenite::protocol::CloseFrame;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

pub struct Event {
    pub id: i32,
    /// "open", "text", "binary" (base64), "close" (data: reason), "error", or "response".
    pub kind: &'static str,
    pub data: String,
    /// Close code or HTTP status.
    pub code: i32,
}

enum Cmd {
    Send(Message),
    Close(u16, String),
}

pub struct Net {
    tx: Sender<Event>,
    rx: Receiver<Event>,
    sockets: HashMap<i32, Sender<Cmd>>,
}

impl Default for Net {
    fn default() -> Self {
        Self::new()
    }
}

impl Net {
    pub fn new() -> Self {
        let (tx, rx) = channel();
        Net { tx, rx, sockets: HashMap::new() }
    }

    pub fn open(&mut self, id: i32, url: String) {
        let (cmd_tx, cmd_rx) = channel();
        self.sockets.insert(id, cmd_tx);
        let events = self.tx.clone();
        thread::spawn(move || run_socket(id, &url, cmd_rx, events));
    }

    pub fn send(&mut self, id: i32, data: String, binary: bool) {
        let message = if binary { Message::Binary(base64_decode(&data)) } else { Message::Text(data) };
        if let Some(tx) = self.sockets.get(&id) {
            let _ = tx.send(Cmd::Send(message));
        }
    }

    pub fn close(&mut self, id: i32, code: u16, reason: String) {
        // The script has already let go of the socket: no event follows a close it asked for.
        if let Some(tx) = self.sockets.remove(&id) {
            let _ = tx.send(Cmd::Close(code, reason));
        }
    }

    pub fn request(&mut self, id: i32, json: String) {
        let events = self.tx.clone();
        thread::spawn(move || {
            let event = match run_request(&json) {
                Ok((status, body)) => Event { id, kind: "response", data: body, code: status },
                Err(reason) => Event { id, kind: "error", data: reason, code: 0 },
            };
            let _ = events.send(event);
        });
    }

    /// Everything that happened since the last call, in order.
    pub fn poll(&mut self) -> Vec<Event> {
        let mut out = Vec::new();
        loop {
            match self.rx.try_recv() {
                Ok(e) => {
                    if e.kind == "close" || e.kind == "error" {
                        // A socket the script closed itself reports nothing further.
                        if self.sockets.remove(&e.id).is_none() && e.kind == "close" {
                            continue;
                        }
                    }
                    out.push(e);
                }
                Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => break,
            }
        }
        out
    }
}

fn set_read_timeout(ws: &WebSocket<MaybeTlsStream<TcpStream>>, t: Duration) {
    let _ = match ws.get_ref() {
        MaybeTlsStream::Plain(s) => s.set_read_timeout(Some(t)),
        MaybeTlsStream::Rustls(s) => s.get_ref().set_read_timeout(Some(t)),
        _ => Ok(()),
    };
}

fn run_socket(id: i32, url: &str, cmds: Receiver<Cmd>, events: Sender<Event>) {
    let send = |kind: &'static str, data: String, code: i32| events.send(Event { id, kind, data, code }).is_ok();
    let mut ws = match tungstenite::connect(url) {
        Ok((ws, _)) => ws,
        Err(e) => {
            send("error", e.to_string(), 1006);
            return;
        }
    };
    // One thread reads and writes: a short read timeout lets queued sends go out promptly.
    set_read_timeout(&ws, Duration::from_millis(5));
    if !send("open", String::new(), 0) {
        return;
    }
    loop {
        loop {
            match cmds.try_recv() {
                Ok(Cmd::Send(m)) => {
                    if let Err(e) = ws.send(m) {
                        send("error", e.to_string(), 1006);
                        return;
                    }
                }
                Ok(Cmd::Close(code, reason)) => {
                    let _ = ws.close(Some(CloseFrame { code: CloseCode::from(code), reason: reason.into() }));
                    let _ = ws.flush();
                    return;
                }
                Err(TryRecvError::Empty) => break,
                // The host is gone: nothing is listening any more.
                Err(TryRecvError::Disconnected) => return,
            }
        }
        match ws.read() {
            Ok(Message::Text(t)) => {
                if !send("text", t.to_string(), 0) {
                    return;
                }
            }
            Ok(Message::Binary(b)) => {
                if !send("binary", base64_encode(&b), 0) {
                    return;
                }
            }
            Ok(Message::Close(frame)) => {
                let (code, reason) = frame.map(|f| (u16::from(f.code) as i32, f.reason.to_string())).unwrap_or((1005, String::new()));
                send("close", reason, code);
                return;
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(e)) if e.kind() == ErrorKind::WouldBlock || e.kind() == ErrorKind::TimedOut => {}
            Err(tungstenite::Error::ConnectionClosed) | Err(tungstenite::Error::AlreadyClosed) => {
                send("close", String::new(), 1005);
                return;
            }
            Err(e) => {
                send("error", e.to_string(), 1006);
                return;
            }
        }
    }
}

/// Returns the status and a JSON `{headers, body}`, or the reason no response arrived.
fn run_request(json: &str) -> Result<(i32, String), String> {
    let req: serde_json::Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let url = req["url"].as_str().ok_or("missing url")?;
    let method = req["method"].as_str().unwrap_or("GET");
    let timeout = Duration::from_millis(req["timeoutMs"].as_u64().unwrap_or(15000));
    let agent = ureq::AgentBuilder::new().timeout(timeout).build();
    let mut call = agent.request(method, url);
    if let Some(headers) = req["headers"].as_object() {
        for (k, v) in headers {
            if let Some(v) = v.as_str() {
                call = call.set(k, v);
            }
        }
    }
    let result = match req["body"].as_str() {
        Some(body) => call.send_string(body),
        None => call.call(),
    };
    let response = match result {
        Ok(r) => r,
        // Any HTTP status is an answer; only a missing one is a failure.
        Err(ureq::Error::Status(_, r)) => r,
        Err(ureq::Error::Transport(t)) => {
            let text = t.to_string();
            return Err(if text.contains("timed out") || text.contains("timeout") { "timeout".into() } else { text });
        }
    };
    let status = response.status() as i32;
    let mut headers = serde_json::Map::new();
    for name in response.headers_names() {
        if let Some(v) = response.header(&name) {
            headers.insert(name.to_lowercase(), serde_json::Value::String(v.to_string()));
        }
    }
    let mut body = Vec::new();
    // 16 MiB is far beyond any service answer; a larger one is a mistake or an attack.
    response.into_reader().take(16 * 1024 * 1024).read_to_end(&mut body).map_err(|e| if e.kind() == ErrorKind::TimedOut || e.kind() == ErrorKind::WouldBlock { "timeout".to_string() } else { e.to_string() })?;
    let body = String::from_utf8_lossy(&body).into_owned();
    Ok((status, serde_json::json!({ "headers": headers, "body": body }).to_string()))
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        out.push(B64[(b[0] >> 2) as usize] as char);
        out.push(B64[(((b[0] & 3) << 4) | (b[1] >> 4)) as usize] as char);
        out.push(if chunk.len() > 1 { B64[(((b[1] & 15) << 2) | (b[2] >> 6)) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[(b[2] & 63) as usize] as char } else { '=' });
    }
    out
}

pub fn base64_decode(text: &str) -> Vec<u8> {
    let vals: Vec<u8> = text.bytes().filter_map(|c| B64.iter().position(|&b| b == c).map(|p| p as u8)).collect();
    let mut out = Vec::with_capacity(vals.len() * 3 / 4);
    for chunk in vals.chunks(4) {
        if chunk.len() > 1 {
            out.push((chunk[0] << 2) | (chunk[1] >> 4));
        }
        if chunk.len() > 2 {
            out.push((chunk[1] << 4) | (chunk[2] >> 2));
        }
        if chunk.len() > 3 {
            out.push((chunk[2] << 6) | chunk[3]);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;
    use std::time::Instant;

    fn wait(net: &mut Net, n: usize) -> Vec<Event> {
        let start = Instant::now();
        let mut out = Vec::new();
        while out.len() < n && start.elapsed() < Duration::from_secs(5) {
            out.extend(net.poll());
            thread::sleep(Duration::from_millis(2));
        }
        out
    }

    #[test]
    fn base64_round_trips() {
        for len in [0usize, 1, 2, 3, 4, 31, 255] {
            let bytes: Vec<u8> = (0..len).map(|i| (i * 37 + 11) as u8).collect();
            assert_eq!(base64_decode(&base64_encode(&bytes)), bytes);
        }
        assert_eq!(base64_encode(&[1, 2, 3]), "AQID");
        assert_eq!(base64_encode(b"hi"), "aGk=");
    }

    #[test]
    fn socket_echoes_text_and_binary_then_reports_the_server_close() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut ws = tungstenite::accept(stream).unwrap();
            for _ in 0..2 {
                let m = ws.read().unwrap();
                ws.send(m).unwrap();
            }
            let _ = ws.close(Some(CloseFrame { code: CloseCode::from(4001), reason: "done".into() }));
            while ws.read().is_ok() {}
        });
        let mut net = Net::new();
        net.open(7, format!("ws://127.0.0.1:{port}/play"));
        let opened = wait(&mut net, 1);
        assert_eq!(opened[0].kind, "open");
        net.send(7, "hello".into(), false);
        net.send(7, "AQID".into(), true);
        let events = wait(&mut net, 3);
        let seen: Vec<(&str, &str, i32)> = events.iter().map(|e| (e.kind, e.data.as_str(), e.code)).collect();
        assert_eq!(seen, vec![("text", "hello", 0), ("binary", "AQID", 0), ("close", "done", 4001)]);
    }

    #[test]
    fn a_refused_connection_is_an_error_and_a_script_close_is_silent() {
        let mut net = Net::new();
        net.open(1, "ws://127.0.0.1:1/".into());
        let events = wait(&mut net, 1);
        assert_eq!((events[0].id, events[0].kind, events[0].code), (1, "error", 1006));

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (done_tx, done_rx) = channel();
        thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut ws = tungstenite::accept(stream).unwrap();
            let closed = loop {
                match ws.read() {
                    Ok(Message::Close(f)) => break f.map(|f| (u16::from(f.code), f.reason.to_string())),
                    Ok(_) => {}
                    Err(_) => break None,
                }
            };
            done_tx.send(closed).unwrap();
        });
        net.open(2, format!("ws://127.0.0.1:{port}/"));
        assert_eq!(wait(&mut net, 1)[0].kind, "open");
        net.close(2, 1000, "bye".into());
        assert_eq!(done_rx.recv_timeout(Duration::from_secs(5)).unwrap(), Some((1000, "bye".to_string())));
        thread::sleep(Duration::from_millis(50));
        assert!(net.poll().is_empty());
    }

    #[test]
    fn request_returns_any_status_with_headers_and_body() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut seen = Vec::new();
            let mut buf = [0u8; 1024];
            // Read until the JSON body has arrived.
            while !String::from_utf8_lossy(&seen).contains("{\"n\":1}") {
                let n = stream.read(&mut buf).unwrap();
                seen.extend_from_slice(&buf[..n]);
            }
            let text = String::from_utf8_lossy(&seen).to_lowercase();
            let ok = text.starts_with("put /v1/saves/a") && text.contains("authorization: bearer t") && text.contains("content-type: application/json");
            let body = if ok { "{\"current\":null}" } else { "bad request seen" };
            write!(stream, "HTTP/1.1 409 Conflict\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });
        let mut net = Net::new();
        let req = serde_json::json!({ "url": format!("http://127.0.0.1:{port}/v1/saves/a"), "method": "PUT", "headers": { "authorization": "Bearer t", "content-type": "application/json" }, "body": "{\"n\":1}", "timeoutMs": 5000 });
        net.request(3, req.to_string());
        let events = wait(&mut net, 1);
        assert_eq!((events[0].id, events[0].kind, events[0].code), (3, "response", 409));
        let answer: serde_json::Value = serde_json::from_str(&events[0].data).unwrap();
        assert_eq!(answer["body"], "{\"current\":null}");
        assert_eq!(answer["headers"]["content-type"], "application/json");
    }

    /// TLS against the public internet; run with `cargo test -- --ignored` when online.
    #[test]
    #[ignore]
    fn tls_request_and_socket_work_with_the_bundled_roots() {
        let mut net = Net::new();
        net.request(1, serde_json::json!({ "url": "https://example.com/", "timeoutMs": 10000 }).to_string());
        let events = wait(&mut net, 1);
        assert_eq!((events[0].kind, events[0].code), ("response", 200), "{}", events[0].data);
        net.open(2, "wss://ws.postman-echo.com/raw".into());
        let opened = wait(&mut net, 1);
        assert_eq!(opened[0].kind, "open", "{}", opened[0].data);
        net.send(2, "over tls".into(), false);
        let echoed = wait(&mut net, 1);
        assert_eq!((echoed[0].kind, echoed[0].data.as_str()), ("text", "over tls"));
    }

    #[test]
    fn request_reports_refusal_and_timeout() {
        let mut net = Net::new();
        net.request(1, serde_json::json!({ "url": "http://127.0.0.1:1/", "timeoutMs": 2000 }).to_string());
        let refused = wait(&mut net, 1);
        assert_eq!((refused[0].kind, refused[0].code), ("error", 0));
        assert_ne!(refused[0].data, "timeout");

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            let (_stream, _) = listener.accept().unwrap();
            thread::sleep(Duration::from_secs(3));
        });
        net.request(2, serde_json::json!({ "url": format!("http://127.0.0.1:{port}/"), "timeoutMs": 300 }).to_string());
        let slow = wait(&mut net, 1);
        assert_eq!((slow[0].kind, slow[0].data.as_str()), ("error", "timeout"));
    }
}
