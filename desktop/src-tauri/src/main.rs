#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod export;
mod svg_export;
mod phase1;
mod state;

fn main() {
    phase1::run();
}
