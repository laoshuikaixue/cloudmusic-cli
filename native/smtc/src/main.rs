// SMTC behavior adapted from SPlayer external-media-integration (AGPL-3.0).
// https://github.com/SPlayer-Dev/SPlayer

#[cfg(not(windows))]
fn main() {
    eprintln!("SMTC is only available on Windows");
}

#[cfg(windows)]
mod windows_bridge {
    use std::{
        io::{self, BufRead, Write},
        sync::{Arc, Mutex},
    };

    use serde::Deserialize;
    use serde_json::json;
    use windows::{
        Foundation::{TimeSpan, TypedEventHandler},
        Media::{
            MediaPlaybackAutoRepeatMode, MediaPlaybackStatus, MediaPlaybackType,
            Playback::MediaPlayer, PlaybackPositionChangeRequestedEventArgs,
            SystemMediaTransportControls, SystemMediaTransportControlsButton,
            SystemMediaTransportControlsButtonPressedEventArgs,
            SystemMediaTransportControlsTimelineProperties,
        },
        Storage::{StorageFile, Streams::RandomAccessStreamReference},
        core::{HSTRING, Ref, Result},
    };

    const HNS_PER_MILLISECOND: f64 = 10_000.0;

    #[derive(Deserialize)]
    #[serde(tag = "type")]
    enum Command {
        #[serde(rename = "metadata")]
        Metadata {
            title: String,
            artist: String,
            album: String,
            #[serde(rename = "coverPath")]
            cover_path: Option<String>,
            id: Option<i64>,
        },
        #[serde(rename = "state")]
        State { playing: bool },
        #[serde(rename = "timeline")]
        Timeline {
            #[serde(rename = "positionMs")]
            position_ms: f64,
            #[serde(rename = "durationMs")]
            duration_ms: f64,
        },
        #[serde(rename = "mode")]
        Mode {
            shuffle: bool,
            repeat: String,
        },
        #[serde(rename = "enable")]
        Enable { enabled: bool },
        #[serde(rename = "shutdown")]
        Shutdown,
    }

    fn send_event(output: &Arc<Mutex<io::Stdout>>, event: serde_json::Value) {
        if let Ok(mut stdout) = output.lock() {
            let _ = writeln!(stdout, "{event}");
            let _ = stdout.flush();
        }
    }

    pub fn run() -> Result<()> {
        let player = MediaPlayer::new()?;
        let smtc = player.SystemMediaTransportControls()?;
        smtc.SetIsEnabled(true)?;
        smtc.SetIsPlayEnabled(true)?;
        smtc.SetIsPauseEnabled(true)?;
        smtc.SetIsStopEnabled(true)?;
        smtc.SetIsNextEnabled(true)?;
        smtc.SetIsPreviousEnabled(true)?;

        let output = Arc::new(Mutex::new(io::stdout()));
        let button_output = Arc::clone(&output);
        let button_handler = TypedEventHandler::new(
            move |_: Ref<SystemMediaTransportControls>,
                  args: Ref<SystemMediaTransportControlsButtonPressedEventArgs>| {
                if let Some(args) = args.as_ref() {
                    let action = match args.Button()? {
                        SystemMediaTransportControlsButton::Play => Some("play"),
                        SystemMediaTransportControlsButton::Pause => Some("pause"),
                        SystemMediaTransportControlsButton::Stop => Some("stop"),
                        SystemMediaTransportControlsButton::Next => Some("next"),
                        SystemMediaTransportControlsButton::Previous => Some("previous"),
                        _ => None,
                    };
                    if let Some(action) = action {
                        send_event(&button_output, json!({ "event": action }));
                    }
                }
                Ok(())
            },
        );
        let _button_token = smtc.ButtonPressed(&button_handler)?;

        let seek_output = Arc::clone(&output);
        let seek_handler = TypedEventHandler::new(
            move |_: Ref<SystemMediaTransportControls>,
                  args: Ref<PlaybackPositionChangeRequestedEventArgs>| {
                if let Some(args) = args.as_ref() {
                    let position = args.RequestedPlaybackPosition()?;
                    send_event(
                        &seek_output,
                        json!({
                            "event": "seek",
                            "positionMs": position.Duration as f64 / HNS_PER_MILLISECOND,
                        }),
                    );
                }
                Ok(())
            },
        );
        let _seek_token = smtc.PlaybackPositionChangeRequested(&seek_handler)?;

        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            let Ok(command) = serde_json::from_str::<Command>(&line) else {
                continue;
            };
            match command {
                Command::Metadata {
                    title,
                    artist,
                    album,
                    cover_path,
                    id,
                } => {
                    let updater = smtc.DisplayUpdater()?;
                    updater.SetType(MediaPlaybackType::Music)?;
                    let props = updater.MusicProperties()?;
                    props.SetTitle(&HSTRING::from(title))?;
                    props.SetArtist(&HSTRING::from(artist))?;
                    props.SetAlbumTitle(&HSTRING::from(album))?;
                    let genres = props.Genres()?;
                    genres.Clear()?;
                    if let Some(id) = id {
                        genres.Append(&HSTRING::from(format!("NCM-{id}")))?;
                    }
                    if let Some(path) = cover_path {
                        if let Ok(operation) = StorageFile::GetFileFromPathAsync(&HSTRING::from(path))
                            && let Ok(file) = operation.join()
                            && let Ok(reference) = RandomAccessStreamReference::CreateFromFile(&file)
                        {
                            updater.SetThumbnail(&reference)?;
                        }
                    }
                    updater.Update()?;
                }
                Command::State { playing } => {
                    smtc.SetPlaybackStatus(if playing {
                        MediaPlaybackStatus::Playing
                    } else {
                        MediaPlaybackStatus::Paused
                    })?;
                }
                Command::Timeline {
                    position_ms,
                    duration_ms,
                } => {
                    let timeline = SystemMediaTransportControlsTimelineProperties::new()?;
                    timeline.SetStartTime(TimeSpan { Duration: 0 })?;
                    timeline.SetPosition(TimeSpan {
                        Duration: (position_ms * HNS_PER_MILLISECOND) as i64,
                    })?;
                    timeline.SetEndTime(TimeSpan {
                        Duration: (duration_ms * HNS_PER_MILLISECOND) as i64,
                    })?;
                    smtc.UpdateTimelineProperties(&timeline)?;
                }
                Command::Mode { shuffle, repeat } => {
                    smtc.SetShuffleEnabled(shuffle)?;
                    let repeat_mode = match repeat.as_str() {
                        "track" => MediaPlaybackAutoRepeatMode::Track,
                        "list" => MediaPlaybackAutoRepeatMode::List,
                        _ => MediaPlaybackAutoRepeatMode::None,
                    };
                    smtc.SetAutoRepeatMode(repeat_mode)?;
                }
                Command::Enable { enabled } => smtc.SetIsEnabled(enabled)?,
                Command::Shutdown => break,
            }
        }
        smtc.SetIsEnabled(false)?;
        Ok(())
    }
}

#[cfg(windows)]
fn main() {
    if let Err(error) = windows_bridge::run() {
        eprintln!("{error:?}");
        std::process::exit(1);
    }
}
