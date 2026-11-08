# Subtitle sample analysis — DVB Italy, ATSC USA and ISDB-T Japan

Sources:
- https://tsduck.io/streams/?stream=italy-sardinia-dttv
- https://tsduck.io/streams/?stream=usa-atsc
- https://tsduck.io/streams/?stream=japan-dttv

## Streams with caption/subtitle signalling

### Italy DVB-T (Sardinia)

PSI files were checked for DVB Teletext (`0x56`) and DVB subtitling (`0x59`) descriptors.

| Mux | Teletext 0x56 | DVB bitmap 0x59 |
|---|---:|---:|
| `mux1rai.ts` | 4 descriptors | 0 |
| `mux2canaleitalia.ts` | 0 | 0 |
| `mux3mediaset.ts` | 6 descriptors | 0 |
| `mux4rai.ts` | 3 descriptors | 0 |
| `muxsardegna1.ts` | 0 | 0 |
| `muxtcs.ts` | 1 descriptor | 0 |
| `muxtelesardegna.ts` | 4 descriptors | 0 |
| `muxvideolina.ts` | 0 | 0 |

There are **no DVB bitmap subtitles (`0x59`)** signalled in this Italy Sardinia snapshot. It is a Teletext-only subtitle source. For bitmap subtitles, use the existing French DVB sample (`dvb-france-uhf33.head.ts` has two `0x59` streams) or another TSDuck DVB source.

Selected for Teletext: `mux1rai.ts`
- File size: 92.91 MB (97,421,788 bytes).
- Teletext subtitle pages are on Rai 1, Rai 2, Rai 3 TGR Sardegna and Rai News 24:
  - Rai 1: program 3401, Teletext PID `0x0240` (576), Italian initial page 100, Italian subtitle page 777, English subtitle page 778.
  - Rai 2: program 3402, Teletext PID `0x0241` (577), same page layout.
  - Rai 3 TGR Sardegna: program 3403, Teletext PID `0x0242` (578), initial page 100 only.
  - Rai News 24: program 3411, Teletext PID `0x0257` (599), Italian initial page 100, Italian subtitle page 777, English subtitle page 778.
Full-file summary:
- DVB, 188-byte TS, 518,201 packets, 32.80 s, 23.76 Mb/s.
- 8 services: Rai 1, Rai 2, Rai 3 TGR Sardegna, Rai News 24, Rai Radio1/2/3, Test HEVC main10.
- `capabilities.teletext = true`, `capabilities.dvbSubtitles = false`.
- Subtitle report total: 78 Teletext cues.
  - Rai 1 / PID `0x0240`: 4 cues.
  - Rai 2 / PID `0x0241`: 38 cues.
  - Rai 3 TGR Sardegna / PID `0x0242`: 32 cues.
  - Rai News 24 / PID `0x0257`: 4 cues.
- Many Rai 2/Rai 3 cues are incremental roll-up updates. The collector now records the latest row-update time, and the report splits them into consecutive intervals (each cue ends at the next same-page update, capped at 5 s) instead of giving all snapshots the same start/end. Style-only updates can still produce repeated visible text.
- Italian accents are correct after re-decoding rows with the final national option subset:
  - `Questa è la pagina 776`
  - `giovedì 28 gennaio`
  - `Torino è stata condannata a un anno e 6 mesi`
- Example cues:
  - Rai 1: `CHIARA APPENDINO  La sindaca di Torino è stata condannata ...`
  - Rai 2: `- TUTTE LE VOLTE CHE LA PALLA E' SULLA DESTRA, MURIEL GIOCA ALLE`
  - Rai 3: `quando a fine 700 l'iniziale stalla venne adibita a pub`
  - Rai News 24: `CASELLATI E FICO Mai dimenticare la Shoah ...`

#### France DVB-T (Paris)

PSI files were checked for `0x59` and `0x56`.

| Mux | DVB bitmap 0x59 | Teletext 0x56 |
|---|---:|---:|
| `tnt-uhf22-482MHz` | 10 descriptors | 0 |
| `tnt-uhf25-506MHz` | 8 descriptors | 0 |
| `tnt-uhf26-514MHz` | 0 | 0 |
| `tnt-uhf28-530MHz` | 1 descriptor | 0 |
| `tnt-uhf30-546MHz` | 11 descriptors | 0 |
| `tnt-uhf32-562MHz` | 9 descriptors | 0 |
| `tnt-uhf33-570MHz` | 2 descriptors | 0 |
| `tnt-uhf35-586MHz` | 8 descriptors | 0 |
| `tnt-uhf42-642MHz` | 9 descriptors | 0 |

This is a real **DVB bitmap subtitle source**: 8 of 9 muxes carry `0x59`, and none carry Teletext. `tnt-uhf30` has the most subtitle descriptors (11), followed by `uhf22` (10), `uhf32`/`uhf42` (9).

Existing reference sample:
- `.cache/streams/dvb-france-uhf33.head.ts`
- Service 3329 `France 2 POC DAS`.
- Two `dvb-subtitle` streams: PID `0x008C` and `0x008E`.
- 23 segments each, page 1.
- Display definition 1919×1079, region 1520×76, depth 2, CLUT id 1, object data present.
- The descriptors are `DVB subtitles, high definition` and `DVB subtitles for hard of hearing, high definition`.

Active bitmap sample:
- `.cache/streams/france-uhf30.head32.ts` — first 32 MB of `tnt-uhf30-546MHz`.
- 11.58 s, 5 services: M6, W9, Arte, France 5, 6ter.
- Visible bitmap display sets were found for M6 (`PID 0x008C`), W9 (`0x00F0`), Arte (`0x0154`) and 6ter (`0x021C`).
- M6 frame: 720×576, regions 600×42 at x=60 y=460/502, 4 timeline frames.
- Decoded subtitle text visually reads:
  - `cache-cache dans le petit bois,`
  - `tout ce qui est course...`
- The WebUI renders the layer at original geometry; transparent areas show the checkerboard.

Bitmap renderer coverage:
- CLUT definition: full-range 8-bit and reduced-range 6/4/4/2-bit entries, YCrCb→RGBA.
- Region composition: fill flag/code, region depth, CLUT id, object placement.
- Page composition: region horizontal/vertical positions, page state 0/2.
- Object data: coding method 0, top/bottom fields, 2/4/8-bit pixel code strings, 2→4/2→8/4→8 map tables, end-of-line.
- Display definition: width/height and optional display window (`display_window_flag`, min/max horizontal/vertical positions). Regions are offset by the window origin and the WebUI clips drawing to the window.
- Synthetic unit tests cover 2-bit, 4-bit and 8-bit objects with and without a display window; the France sample itself mainly exercises 4-bit objects.

#### Australia DVB-T (Melbourne)

PSI files were checked for the same descriptors.

| Mux | Teletext 0x56 | DVB bitmap 0x59 |
|---|---:|---:|
| `ABC.ts` | 6 descriptors | 0 |
| `Nine.ts` | 9 descriptors | 0 |
| `SBS.ts` | 7 descriptors | 0 |
| `Seven.ts` | 8 descriptors | 0 |
| `Ten.ts` | 6 descriptors | 0 |

Again, **no DVB bitmap subtitles** are signalled. All five Australian muxes carry Teletext subtitle pages only.

#### Netherlands DVB-T2 (Digitenne)

PSI files were checked for the same descriptors.

| Mux | Teletext 0x56 | DVB bitmap 0x59 |
|---|---:|---:|
| `digitenne-482-2020-06-21.ts` | 5 descriptors | 0 |
| `digitenne-490-2020-06-21.ts` | 2 descriptors | 0 |
| `digitenne-594-2020-06-21.ts` | 5 descriptors | 0 |
| `digitenne-658-2020-06-21.ts` | 1 descriptor | 0 |
| `digitenne-682-2020-06-21.ts` | 5 descriptors | 0 |

No DVB bitmap subtitles are signalled in the Dutch Digitenne snapshot either; only some services carry Teletext subtitle pages.

### USA ATSC

PSI files were checked for the ATSC Caption Service descriptor (`0x86`) on video PIDs.

| Stream | Caption descriptors | Notes |
|---|---:|---|
| `473.ts` | 1 | Program 6 / Quest: 608 line 21 + 708 service 1; selected for analysis |
| `479.ts` | 5 | Mostly empty caption descriptors; program 7 has 708 service 1 |
| `491.ts` | 0 | — |
| `503.ts` | 0 | — |
| `509.ts` | 1 | Caption service present |
| `515.ts` | 1 | Caption service present |
| `527.ts` | 0 | — |
| `533.ts` | 3 | Caption services present |
| `539.ts` | 1 | Caption service present |
| `545.ts` | 0 | — |
| `551.ts` | 0 | — |
| `557.ts` | 0 | — |
| `563.ts` | 0 | — |
| `569.ts` | 4 | Caption services present |
| `593.ts` | 0 | — |
| `599.ts` | 4 | Caption services present |
| `605.ts` | 0 | — |

`473.ts` was selected because its `0x86` descriptor declares both line 21 (CEA-608) and digital service 1 (CEA-708) in one stream.

### Japan ISDB-T

PSI files were checked for ISDB Data Component descriptor (`0xFD`) values `0x0008` (ARIB subtitle & teletext) and `0x0012` (subtitle coding, C profile).

| Stream | Caption components | Notes |
|---|---:|---|
| `AAB.ts` | 7 | Main services + 1-seg data service; selected for analysis |
| `ABS.ts` | 5 | Main services + 1-seg data service |
| `AKT.ts` | 5 | Main services + 1-seg data service |
| `NHK.ts` | 5 | Main services + 1-seg data service |
| `NHKE.ts` | 7 | Main services + 1-seg data service |

In these captures, the main-service ARIB caption PIDs carry CA descriptors and are scrambled. The 1-seg data service is the clear caption path; `AAB.ts` PID `0x0314` was selected because it is clear and decodable.

## Selected streams

### USA ATSC — `usa-atsc/473.ts`

Why this stream:
- `473.psi.txt` shows a PMT for program 6 (`Quest`, 10.4) with an **ATSC Caption Service descriptor (0x86)** on the MPEG-2 video PID `0x0061`.
- The descriptor declares three services:
  - `eng`, digital: false, line 21: false
  - `eng`, digital: false, line 21: true
  - `eng`, digital: true, service 1
- This means the stream carries both CEA-608 (line 21) and CEA-708 (digital service 1) caption data.

File size: 146.69 MB (153,814,268 bytes).
Download: complete in `.cache/streams/usa-atsc-473.full.ts`.

Full-file summary:
- ATSC, 188-byte TS, 818,161 packets, 63.42 s, 19.40 Mb/s.
- Services: KULX (10.1), TelXito (10.2), LightTV (10.3), Quest (10.4).
- `capabilities.atscCaptions = true`.
- Subtitle report now returns **two independent streams** for program 6 / PID `0x0061`:
  - `ATSC CEA-608`, channel CC1, 15 cues in the 63 s clip.
  - `ATSC CEA-708`, service 1, 15 cues and 1,291 DTVCC bytes.
- The 608 decoder reconstructs the 15×32 screen and pop-on/roll-up modes. Example cues:
  - `26697.796`: `that will prevent dogs and\n  cats from getting in`
  - `26697.829`: the same line from the 708 service.
- The 708 decoder parses DTVCC packets, service blocks, `DefineWindow`, `SetPenAttributes`, `SetPenColor`, `SetPenLocation`, `SetWindowAttributes`, window map commands and text/CR/ETX. The previous single long cue is now split into 15 display intervals.
- The 708 window preview carries the window anchor, row/column count, fill colour/opacity, pen colours, italics and underline.

Frame-level checks on the first 16 MB head (`atsc-473.head.ts`, 6.86 s):
- 608: 3 cues, first `that will prevent dogs and / cats from getting in`.
- 708: 3 cues, same text, service 1, window 1.

Why the old report showed one cue:
- The previous decoder concatenated 708 text until CR/ETX and ignored window `display/hide` commands. It also picked 708 over 608 instead of exposing both.

### Japan ISDB-T — `japan-dttv/AAB.ts`

Why this stream:
- `AAB.psi.txt` shows services 18464–18466 with **ISDB Data Component descriptor (0xFD) data component id 0x0008** (“ARIB subtitle & teletext coding”) on PIDs `0x0114` and `0x0115`.
- The 1-seg data service 18848 has data component id `0x0012` (“Subtitle coding for digital terrestrial broadcasting (C profile)”) on PID `0x0314`.
- The main-service caption PIDs (`0x0114`/`0x0115`) carry CA descriptors. In this capture they are scrambled, so main-service captions are not decodable without keys.
- The 1-seg caption PID `0x0314` is clear and carries decodable ARIB captions.

File size: 131.41 MB (137,789,148 bytes).
Download: complete in `.cache/streams/japan-dttv-AAB.full.ts`.

Full-file summary:
- ISDB, 188-byte TS, 732,921 packets, 63.39 s, 17.39 Mb/s.
- Services: three `秋田朝日放送` TV services and one `秋田朝日放送` data service.
- `capabilities.aribCaptions = true`, `capabilities.scrambled = true`, CA systems 5 and 14.
- Main-service caption PIDs `0x0114`/`0x0115` are CA-scrambled. The report lists them but extracts 0 cues.
- 1-seg caption PID `0x0314` is clear: 12 ARIB cues in the 63 s clip.

All extracted 1-seg cues:
- `50109.362`: `日本には３０００を超える温泉があるけれど→`
- `50114.367`: `ミシュランが評価して 星を付けたのは→`
- `50118.388`: `数カ所しかなく→`
- `50122.375`: `その中で　民間施設唯一の三つ星が この温泉なのです。`
- `50129.349`: `（ジュニア）すげえ！（羽田）すごい！`
- `50131.367`: `…で　珍百景は こちらのお宅に。`
- `50148.351`: `外で飼っている 雄のワンちゃんに会うため→`
- `50152.372`: `野良ネコがやって来るという。`
- `50154.374`: `（原田）フフフ…。 どんな気持ちなんだろう？`
- `50158.394`: `とはいえ　野良ネコ。`
- `50161.347`: `都合良く　今日も来てくれるのか？`
- `50167.353`: `待っていると…。`

The data-unit loop is now parsed with its 5-byte unit header (`US 0x1F`, parameter `0x20`, 24-bit size), so the previous trailing ASCII leftovers (` h`, ` ^`, ` T`) no longer appear. `TIME` (`0x9D`) and trailing `CS` (`0x0C`) are consumed as controls.

Preview:
- The WebUI renders an **ARIB style-layer preview** using the original video size (320×180 for the 1-seg service).
- The statement body is decoded as styled runs. The AAB sample uses cyan (`CNF 0x86`) and white (`WHF 0x87`) foreground, normal (`NSZ 0x8A`) and medium (`MSZ 0x89`) sizes, and medium sizing for half-width punctuation.
- Text is bottom-centered when the stream carries no position command. APB/APF/APD/APU/APR/APS and CSI ACPS/SDP/SDF positions are parsed for samples that carry them.
- Underline (`STL`/`SPL`), ornament (`CSI ... c`), bold/italic (`CSI ... d`), conceal, flash, background colour (`COL`) and character spacing (`SSM`/`SHS`/`SVS`) are also decoded.
- DRCS glyphs and A/C-profile broadcast font metrics are now implemented; the AAB sample itself contains no DRCS data units.

### Japan ISDB-T — `japan-dttv/NHK.ts`

- Full file: 63.79 s, 137,789,148 bytes.
- Unlike AAB, the main-service caption PID `0x0130` is clear in this capture.
- The report decodes 15 cues for each of the two main services and 14 cues for the 1-seg data service.
- Main captions use A-profile CSI commands:
  - `CSI 7 S` (SWF)
  - `CSI 620;480 V` (SDF)
  - `CSI 170;30 _` (SDP)
  - `CSI 4 X`, `CSI 24 Y`, `CSI 36;36 W` (character metrics)
  - `CSI 1;0000 c` (ornament)
  - `COL` palette/background and `APS` row/column.
- Example cues:
  - `73407.247`: `コメントし、` at row 4, white text on a red background.
  - `73413.820`: `当局の監視が続くおそれがあると` / `して、懸念を強めています。` at rows 3 and 4.
- A-profile metrics: logical plane 960×540, display area 620×480 at (170,30), font 36×36, spacing 4×24, cell 40×60.
- C-profile metrics: logical plane 320×180, display area 300×160 at (0,0), font 18×18, spacing 2×12, cell 20×30.

### Japan ISDB-T — `japan-dttv/ABS.ts`

- Full file: 63.76 s, 137,789,148 bytes.
- Services: `ABS秋田放送1`, `ABS秋田放送2`, `秋田放送携帯`.
- The 1-seg data service caption PID `0x0887` is clear and yields 21 C-profile cues.
- Main-service caption PIDs `0x0130`/`0x0138` yield 0 cues in this capture.
- No DRCS data units were found.

### DRCS

- No DRCS data units were found in the AAB, NHK or ABS full clips; the NHK main captions use standard JIS X 0208 text.
- DRCS parsing follows ARIB STD-B24 Annex D:
  - `number_of_code`, `character_code`, `number_of_font`
  - `font_id`/`mode`
  - mode 0/1: `depth`, `width`, `height`, `patternData`
  - depth 0 = 2 levels / 1 bit per pixel
  - 1-byte DRCS-1..15 and 2-byte DRCS-0 codes
- A synthetic fixture built from the Annex D example (`character_code 0x4121`, 16×18, `⁈`) verifies the WebUI glyph rendering and A-profile metrics.
- C-profile text references DRCS by single bytes `0x21`-`0x2E`; the decoder replaces them with private-use characters and carries the glyph mask to the WebUI.
- Real DRCS samples (speaker/phone icons, rare Kanji) are still wanted for end-to-end validation.

## Current limitations

- ATSC 608 and 708 are now separate stream entries. The 608 report chooses the channel with the most text (normally CC1); CC2–CC4 are not emitted as separate tracks yet.
- 608 background/box attributes and some PAC edge cases are still approximate. 708 display effects (fade/wipe) are not animated and window borders are drawn as a simple rectangle.
- 708 auto-wrap can split a word at the 32-column boundary; the 608 text is usually cleaner for the same cue.
- Teletext rolling cues are split by update time; repeated style-only updates can still produce several cues with the same visible text.
- DVB display-window offsets and 2/4/8-bit decoding have synthetic coverage; real samples still mainly exercise 4-bit objects.
- AAB main-service captions are CA-scrambled; the AAB 1-seg data service and the NHK main service are clear.
- ARIB colours, sizes, underline, ornament, bold/italic, CSI positions, DRCS glyphs and A/C-profile font metrics are decoded. Real DRCS samples are still needed for wider validation.
