# Native video test fixture

`native-video.webm` is a generated solid-color VP8 video: 160×90 pixels, 10 fps,
20 frames, two seconds, no audio. It has no third-party content.

Generate it with FFmpeg (only needed when replacing the fixture, not in CI):

```sh
ffmpeg -f lavfi -i 'color=c=0x80baff:s=160x90:r=10:d=2' \
  -c:v libvpx -b:v 100k -an -y test/fixtures/native-video.webm
```

A committed clip avoids coupling native video decoding tests to a brief,
runtime canvas recording and headless encoder scheduling. The browser test
explicitly loads the media and verifies its dimensions and duration. It does
not require autoplay permission. Failures write media state and network/CSP
information to the uploaded artifacts.
