# Canvas Fake HDR

Builds off of https://kidi.ng/wanna-see-a-whiter-white/
Interpolate HDR solid color videos in canvas

- [ ] Study performance hit
  - getImageData()/putImageData() are expensive, use drawImage
    ```
    // jsperf.com/copying-a-canvas-element
    var destinationCtx;

    // get the destination context
    destinationCtx = destinationCanvas.getContext('2d');

    // draw the image
    destinationCtx.drawImage(sourceCanvas, 0, 0);
    ```
  - Isolate each color channel and use as mask in CSS?
- [ ] Disable filters when `window.matchMedia("(dynamic-range: high)").matches` === false
- [ ] Toggle for color correction?
  - [ ] Shows as green for non-HDR screens
- [ ] Remove extraneous videos
- [ ] Try with fill values between first and second
- [ ] Detect iOS fake HDR?