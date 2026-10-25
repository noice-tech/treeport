use std::{
    io::Write,
    sync::{mpsc, OnceLock},
    thread,
};

// eprintln! panics when writing to stderr fails.
pub fn report(mut message: String) {
    static SENDER: OnceLock<mpsc::SyncSender<String>> = OnceLock::new();
    let sender = SENDER.get_or_init(|| {
        let (sender, receiver) = mpsc::sync_channel::<String>(32);
        let _ = thread::Builder::new()
            .name("keeper-diagnostics".into())
            .spawn(move || {
                for message in receiver {
                    let _ = writeln!(std::io::stderr().lock(), "{message}");
                }
            });
        sender
    });
    if message.len() > 8192 {
        let mut end = 8192;
        while !message.is_char_boundary(end) {
            end -= 1;
        }
        message.truncate(end);
    }
    let _ = sender.try_send(message);
}
