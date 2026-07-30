// Prevents a console window from appearing alongside the app on Windows
// release builds. Debug builds keep it so `tracing` output stays visible.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    telewire_lib::run();
}
