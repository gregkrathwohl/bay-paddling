# Ideas for later

## Next
- Whole-Bay routing (route grid as tiles, loaded along the way)
- Launches for the whole Bay
- Retire the Richardson Bay map once the whole Bay has routing (move its launches, labels, racing buoys)

## Pretty land / screensaver mode (2026-11-18)
Make the whole-Bay map beautiful enough to leave on a TV or as a background:
- Land styling pass: hillshade, softer palette, fewer roads, nicer place names
- `?screensaver` mode: no panels or controls, tides playing slowly (or real time), streaks only,
  maybe a small clock and tide line
- Mac screensaver: no video needed; an open-source web-view screensaver (e.g. WebViewScreenSaver)
  can show any URL, so it would just point at the published `?screensaver` page
- TV: open the same URL in the TV's browser or cast a Chrome tab
- Fallback if a live page is a problem: render a looping video of a tide cycle (headless browser
  recording), refreshed by the publish job
