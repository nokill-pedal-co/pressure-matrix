# Pressure Matrix

A free synth that runs in your browser. It's inspired by the Expressive E Osmose, where every key has strike, press and sideways pitch, and by the kinds of synthesis in Haken's EaganMatrix engine.

**Play it:** https://nokill-pedal-co.github.io/pressure-matrix/

- **Laptop keys:** the Z and Q rows play notes. Shift gives a hard strike, holding Space presses into the notes, and the arrow keys bend and change octave.
- **MIDI keyboard:** plug one in over USB, open the page in Chrome or Edge, and press MIDI. Velocity sets strike, aftertouch sets press, and the pitch and mod wheels or strips bend and change timbre. MPE controllers get per-note control.
- **Six engines:** virtual analog, a sine bank, a formant bank, modal resonators, a bowed string and a plucked string.

Everything is in `index.html`, with the audio engine also in `pm-dsp.js`. There's nothing to install.

Not affiliated with Expressive E, Haken Audio or Behringer.
