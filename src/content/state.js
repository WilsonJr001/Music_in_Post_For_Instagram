/**
 * Shared state
 *
 * Every other content-script module reads and writes these. They live in
 * one place so the lifetime of a player — its audio element, its DOM node,
 * its timers — is describable without reading the whole extension.
 *
 * Part of the Instagram Photo Audio Enabler content script.
 * Loaded in the order declared in manifest.json; all content-script
 * files share one scope, so these names are visible across files.
 */
'use strict';

/** Map<shortcode, { audioUrl, startTime, duration }> — stores discovered audio data */
const audioDataMap = new Map();

/** Map<HTMLElement, { audio: HTMLAudioElement, player: HTMLElement, shortcode: string }> */
const activePlayers = new Map();

/** The <article> element currently playing audio (only one at a time) */
let currentlyPlaying = null;

/**
 * Autoplay unlock flag.
 * Browsers block audio.play() until the user interacts with the page.
 * We track this and retry playback on the first user gesture.
 */
let autoplayUnlocked = false;

/** The article that was waiting for autoplay unlock (pending play) */
let pendingAutoplayArticle = null;

/** Maps an observed media container back to its <article> */
const observedTargets = new Map();

/**
 * Session-wide sound preference, off by default — the convention every
 * social feed uses: audio follows the post you are looking at, but stays
 * muted until you ask for it. Muted playback is also exempt from browser
 * autoplay blocking, so the music is already in position (and at the
 * right offset in the track) the moment you unmute.
 */
let soundEnabled = false;

/** Playback volume, also global and persisted (0..1) */
let globalVolume = 0.7;

let debounceTimer = null;

/** Regex to extract shortcode from Instagram post URLs */
const SHORTCODE_REGEX = /\/(p|reel|reels)\/([A-Za-z0-9_-]+)/;

/** Articles already handed to the discovery observer */
const discoveryObserved = new WeakSet();

/**
 * Discovery mode. When true the extension asks Instagram for the audio of
 * posts that reach the screen, which is what makes the feed work at the
 * cost of one request per post looked at. When false it only reads
 * responses Instagram fetches on its own, so audio appears when you open a
 * post and never while scrolling. Set on the options page.
 */
let discoveryEnabled = true;

/**
 * How far below the fold to start asking, in pixels. Scrolling a feed is
 * a continuous motion, so a post a screen and a half down is very likely
 * the next one looked at. Asking early means its track is already in hand
 * when it arrives instead of after a round trip.
 */
const PREFETCH_MARGIN_PX = 1200;

/** Shortcodes we have already asked inject.js about */
const infoAsked = new Set();

/** How long the player stays put before retreating (ms) */
const IDLE_AFTER_MS = 2500;

/** How long the muted marker shows itself on arrival (ms) */
const HINT_DURATION_MS = 4500;

/** Minimum visibility for a post to claim playback */
const PLAY_THRESHOLD = 0.6;
