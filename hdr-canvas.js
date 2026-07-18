// hdr-canvas.js
//
// Draws the contents of a source canvas onto an output canvas using a
// WebGPU rgba16float context with extended tone mapping (HDR) when the
// browser and display support it, or a plain 2D drawImage fallback (SDR).
//
// Usage:
//   const hdr = await initHdrCanvas(srcCanvas, outCanvas);
//   hdr.mode          // 'hdr' | 'sdr'
//   hdr.setBrightness(2.5)  // HDR only; no-op in SDR mode
//   hdr.render()      // call each frame after drawing to srcCanvas

const log = (msg) => console.log('[hdr-canvas]', msg);

export async function initHdrCanvas(srcCanvas, outCanvas) {
  const W = srcCanvas.width;
  const H = srcCanvas.height;

  ////////////////////////////////////////////////////////////////////////
  // Capability check: WebGPU + HDR display
  ////////////////////////////////////////////////////////////////////////
  const hdrMediaQuery = window.matchMedia('(dynamic-range: high)');
  let device = null;
  if (!navigator.gpu) {
    log('⚠️ WebGPU is not available - falling back to a 2D canvas (SDR).');
  } else if (!hdrMediaQuery.matches) {
    log("⚠️ Display isn't HDR-compatible - falling back to a 2D canvas (SDR).");
  } else {
    const adapter = await navigator.gpu.requestAdapter();
    device = (await adapter?.requestDevice()) ?? null;
    if (!device) {
      log('⚠️ Failed to get a WebGPU device - falling back to a 2D canvas (SDR).');
    }
  }

  // Probe rgba16float + extended tone mapping (Firefox supports WebGPU
  // but not rgba16float canvases). Probing uses a throwaway canvas so
  // out-canvas can still get a '2d' context if we end up falling back.
  let presentationFormat = null;
  if (device) {
    const probeContext = document.createElement('canvas').getContext('webgpu');
    if (probeContext) {
      try {
        probeContext.configure({ device, format: 'rgba16float', toneMapping: { mode: 'extended' } });
        presentationFormat = 'rgba16float';
      } catch (e) {
        log(`⚠️ Canvas format 'rgba16float' not supported: ${e.message}`);
      }
      probeContext.unconfigure();
    }
    if (!presentationFormat) {
      log('⚠️ No usable WebGPU canvas format - falling back to a 2D canvas (SDR).');
      device = null;
    }
  }

  ////////////////////////////////////////////////////////////////////////
  // Fallback path: plain 2D canvas, drawImage from the source canvas.
  ////////////////////////////////////////////////////////////////////////
  if (!device) {
    const outCtx = outCanvas.getContext('2d');
    return {
      mode: 'sdr',
      setBrightness() {}, // no-op in SDR mode
      render() {
        outCtx.drawImage(srcCanvas, 0, 0, outCanvas.width, outCanvas.height);
      },
    };
  }

  ////////////////////////////////////////////////////////////////////////
  // WebGPU path: rgba16float + extended tone mapping (HDR)
  ////////////////////////////////////////////////////////////////////////
  const context = outCanvas.getContext('webgpu');
  context.configure({
    device,
    format: presentationFormat,
    toneMapping: { mode: 'extended' },
  });
  log(`ℹ️ WebGPU canvas format: ${presentationFormat}`);

  if ('getConfiguration' in GPUCanvasContext.prototype) {
    const mode = context.getConfiguration()?.toneMapping?.mode;
    if (mode !== 'extended') {
      log("⚠️ Browser doesn't support HDR canvas, fell back to '" + mode + "').");
    } else {
      log('✅ HDR canvas enabled.');
    }
  } else {
    log('ℹ️ getConfiguration() unavailable.');
  }

  // Bridge: copy the 2D canvas into a texture each frame, then render
  // it fullscreen multiplied by the brightness factor. An 8-bit 2D
  // canvas only holds 0–1 values, so the multiply is what pushes
  // highlights into HDR range.
  const srcTexture = device.createTexture({
    size: [W, H],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });

  const shaderModule = device.createShaderModule({
    code: /* wgsl */ `
      @group(0) @binding(0) var samp: sampler;
      @group(0) @binding(1) var tex: texture_2d<f32>;
      @group(0) @binding(2) var<uniform> brightness: f32;

      struct VSOut {
        @builtin(position) pos: vec4f,
        @location(0) uv: vec2f,
      };

      @vertex
      fn vs(@builtin(vertex_index) i: u32) -> VSOut {
        // Fullscreen triangle
        let pos = array(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
        var out: VSOut;
        out.pos = vec4f(pos[i], 0, 1);
        out.uv = pos[i] * vec2f(0.5, -0.5) + 0.5;
        return out;
      }

      @fragment
      fn fs(in: VSOut) -> @location(0) vec4f {
        let c = textureSample(tex, samp, in.uv);
        return vec4f(c.rgb * brightness, 1.0);
      }
    `,
  });

  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: shaderModule, entryPoint: 'vs' },
    fragment: {
      module: shaderModule,
      entryPoint: 'fs',
      targets: [{ format: presentationFormat }],
    },
    primitive: { topology: 'triangle-list' },
  });

  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  const brightnessBuffer = device.createBuffer({
    size: 4,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: sampler },
      { binding: 1, resource: srcTexture.createView() },
      { binding: 2, resource: { buffer: brightnessBuffer } },
    ],
  });

  return {
    mode: 'hdr',
    setBrightness(value) {
      device.queue.writeBuffer(brightnessBuffer, 0, new Float32Array([value]));
    },
    render() {
      device.queue.copyExternalImageToTexture(
        { source: srcCanvas },
        { texture: srcTexture },
        [W, H]
      );

      const commandEncoder = device.createCommandEncoder();
      const passEncoder = commandEncoder.beginRenderPass({
        colorAttachments: [
          {
            view: context.getCurrentTexture().createView(),
            clearValue: [0, 0, 0, 1],
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      passEncoder.setPipeline(pipeline);
      passEncoder.setBindGroup(0, bindGroup);
      passEncoder.draw(3);
      passEncoder.end();
      device.queue.submit([commandEncoder.finish()]);
    },
  };
}
