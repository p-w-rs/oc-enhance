---
name: ml-deploy
description: Deploy and optimize neural networks on NVIDIA edge and CUDA devices (Jetson Orin/Thor, discrete GPUs) with TensorRT 11 — export (torch.export/ONNX), strongly typed precision and ModelOpt quantization (INT8/FP8/FP4/INT4), custom TensorRT plugins for novel layers (IPluginV3, Python tensorrt.plugin, Torch-TensorRT converters), running independent branches in parallel, CUDA graphs, DLA, benchmarking and profiling, and a full training-to-device optimization checklist. Load before any export, TensorRT, Jetson or inference-optimization work.
---

# Edge deployment with TensorRT 11

## 0. Ground truth before code (always)

Your training data predates TensorRT 11 and recent JetPacks. **Do not write TensorRT code from memory.**

1. **Check what is installed where it will run** (the device, not your laptop):
   ```sh
   cat /etc/nv_tegra_release; dpkg -l | grep -E "nvidia-jetpack|tensorrt|cuda-toolkit|cudnn" | awk '{print $2,$3}'   # Jetson
   python -c "import tensorrt as trt; print(trt.__version__)"; trtexec --help | head -3; nvcc --version; nvidia-smi
   ```
2. **Read the docs for that exact version** before using an API, flag or sample:
   - Release notes and the **TRT 10 → 11 migration guide**: https://docs.nvidia.com/deeplearning/tensorrt/latest/getting-started/release-notes.html,
     https://docs.nvidia.com/deeplearning/tensorrt/latest/api/migration-guide.html
   - Python/C++ API: …/latest/api/python-api.html, …/latest/api/c-api.html; operators: …/latest/api/operators.html
   - Support matrix (precisions per compute capability, CUDA, drivers): …/latest/getting-started/support-matrix.html
   - Samples (the best reference code): https://github.com/NVIDIA/TensorRT/tree/main/samples (check out the tag
     matching the installed version)
   - ModelOpt: https://nvidia.github.io/Model-Optimizer/ · Torch-TensorRT: https://docs.pytorch.org/TensorRT/
   - Jetson: https://developer.nvidia.com/embedded/jetpack/downloads, Jetson Linux developer guide for the L4T release
   Use `webfetch` on these; quote the version you relied on in comments or the PR.
3. When docs and memory disagree, docs win. When the installed version differs from the docs' `latest`, use the
   versioned docs (`/archive/<version>/`).

### Version facts as of November 2026 (verify; they move)

| Item | State |
|---|---|
| TensorRT | 11.x (11.0 June 2026 … 11.4.1 Oct 2026). Min compute capability 7.5. |
| JetPack 7.2.1 (current download) | L4T 39.2.1, CUDA 13.2.2, **TensorRT 10.16.2**, Ubuntu 24.04 |
| TensorRT 11 on Jetson | **11.4.1+ with JetPack 7.2.2+**, AGX Orin and Thor (install the SBSA TensorRT package). JetPack 6.x stays on TRT 10.x. Orin NX/Nano support for TRT 11: check the support matrix. |
| DLA | AGX Orin only (Thor has no DLA); with TRT 11 needs 11.4.1 + JetPack 7.2.2 |
| Compute capability | AGX Orin 8.7 (INT8, FP16; no FP8/FP4), Thor 11.0 (FP8, FP4/NVFP4, BF16, INT8) |
| Torch-TensorRT | 2.14 (PyTorch 2.14, TRT 11.1; Jetson Thor/Orin aarch64 wheels) |
| ModelOpt | 0.48 |
| ONNX for TRT 11 | opsets 9–25; export at the newest opset your exporter supports |

So: on a device with JetPack 7.2.1 you write **TensorRT 10.16** code (still allows weak typing and builder
precision flags), and on TRT 11 you must use the strongly typed workflow below. Write code that works for the
version actually installed, and say which one.

## 1. TensorRT 11 essentials (what changed from 10)

- **Networks are always strongly typed.** Precision comes from tensor types in the model (casts, Q/DQ nodes), not
  from builder flags. Removed: `BuilderFlag.FP16/BF16/INT8/FP8/INT4/FP4`, `OBEY/PREFER_PRECISION_CONSTRAINTS`,
  per-layer `precision`/`set_output_type`, `ITensor.set_type`/`dynamic_range`, all `IInt8Calibrator`s (implicit
  quantization is gone). `TF32` is still a flag.
- **trtexec**: `--fp16 --bf16 --int8 --fp8 --int4 --best --calib --precisionConstraints --layerPrecisions` are
  errors. CUDA graphs are on by default (`--noCudaGraph` to disable); data transfers are excluded from timing by
  default (`--includeDataTransfers`). `--stronglyTyped` is a no-op.
- **Renames** (Python): `device_memory_size` → `device_memory_size_v2`, `weight_streaming_budget` →
  `weight_streaming_budget_v2`, `create_execution_context_without_device_memory()` → `create_execution_context()`,
  `plugin_creator_list` → `all_creators`, `get_plugin_creator` → `get_creator`. Tactic sources cuBLAS/cuBLASLt/cuDNN
  removed; plugins that relied on cuDNN are unsupported; many legacy built-in plugins (NMS family, Proposal, …) removed.
- TRT 10 engines built with `--versionCompatible` load in TRT 11; otherwise rebuild. **Engines are tied to the GPU
  model and TRT version**: build on the target device (or an identical one), never ship an engine built elsewhere.

### Precision workflow on TRT 11

```sh
# FP16 (or BF16 with -t bf16) with sensitive ops kept in FP32: ModelOpt AutoCast rewrites the ONNX types
python -m modelopt.onnx.autocast --onnx_path model.onnx --output_path model_fp16.onnx
# INT8 / FP8 / INT4: explicit Q/DQ with calibration data (representative inputs, .npz)
python -m modelopt.onnx.quantization --onnx_path model.onnx --quantize_mode int8 --calibration_data_path calib.npz --output_path model_int8.onnx
trtexec --onnx=model_int8.onnx --saveEngine=model.engine --timingCacheFile=timing.cache
```
- The ONNX quantization CLI supports `--quantize_mode int8|fp8|int4`; NVFP4 comes from PyTorch-side ModelOpt
  (`mtq.quantize`) before export.
- Choose by hardware: Orin → FP16 + INT8 (no FP8/FP4); Thor/Blackwell → FP8, NVFP4 (block 16) also viable; INT4 AWQ
  for LLM weights (Ampere+). Quantize in PyTorch with ModelOpt (`mtq.quantize`, QAT if PTQ loses accuracy) when you
  control training; ONNX-level PTQ otherwise. **Always measure accuracy** against the FP32 model on a real validation
  set, per output, before calling it done.
- Keep accumulations/normalizations/softmax in FP32 where AutoCast suggests; check with `--exportLayerInfo` that the
  precisions are what you intended.

## 2. Export

- PyTorch 2.9+: `torch.onnx.export(model, args, "m.onnx", dynamo=True, dynamic_shapes=..., opset_version=<newest
  supported>)` (torch.export-based; `dynamic_axes` is the legacy path). Fix graph breaks/data-dependent control flow
  in the model rather than fighting the exporter.
- Clean up: `polygraphy surgeon sanitize m.onnx --fold-constants -o m_folded.onnx`; inspect with `polygraphy inspect
  model`. Compare outputs: `polygraphy run m.onnx --trt --onnxrt --atol … --rtol …`.
- Alternative without ONNX: Torch-TensorRT (`torch_tensorrt.compile(model, ir="dynamo", inputs=..., ...)` or
  `torch_tensorrt.dynamo.compile` + `save` for AOT). Check its TRT version matches the device.
- Dynamic shapes: give realistic `min/opt/max` (`--minShapes/--optShapes/--maxShapes`); `opt` = the size you
  benchmark and deploy. Several profiles if you serve very different sizes.

## 3. Custom layers: TensorRT plugins (novel architectures)

When the ONNX parser or Torch-TensorRT rejects an op (check the parser's operator list for the installed version),
or a fused custom kernel beats TRT's tactics, write a **plugin**. Prefer, in order:

1. **Rewrite the op** in supported primitives (often enough and keeps TRT's fusions). Profile before and after.
2. **Python quickly deployable plugin** (`tensorrt.plugin`, TRT ≥ 10.6), with an **AOT** implementation (Triton or
   CUDA compiled to PTX/cubin) so the engine runs **without Python** on the device:
   ```python
   import tensorrt.plugin as trtp
   @trtp.register("myns::fused_op")                 # shapes/types: TensorDesc in → TensorDesc(s) out
   def fused_op_desc(x: trtp.TensorDesc, alpha: float) -> trtp.TensorDesc: return x.like()
   @trtp.aot_impl("myns::fused_op")                 # → (kernel name, PTX/cubin, trtp.KernelLaunchParams, trtp.SymIntExprs)
   def fused_op_aot(x: trtp.TensorDesc, alpha: float, outputs, tactic: int): ...
   @trtp.autotune("myns::fused_op")                 # dtype/format combinations TRT may choose from
   def fused_op_autotune(x, alpha, outputs): return [trtp.AutoTuneCombination("FP32|FP16, FP32|FP16", "LINEAR")]
   ```
   ONNX: a node with `op_type` = the plugin name, attribute `plugin_namespace` (and `aot`). Samples:
   `samples/python/quickly_deployable_plugins`, `non_zero_plugin`, `aliased_io_plugin`, `cute_dsl_plugin`.
3. **C++ `IPluginV3`** (the interface for TRT 10/11; `IPluginV2*` is deprecated): a class implementing
   `IPluginV3` + `IPluginV3OneCore` (name/version/namespace) + `IPluginV3OneBuild` (`getNbOutputs`,
   `getOutputDataTypes`, `getOutputShapes` with `IExprBuilder`, `supportsFormatCombination`, `configurePlugin`,
   `getWorkspaceSize`) + `IPluginV3OneRuntime` (`onShapeChange`, `enqueue(..., cudaStream_t)` returning 0,
   `getFieldsToSerialize`, `attachToContext`, `clone`), and an `IPluginCreatorV3One` registered with
   `REGISTER_TENSORRT_PLUGIN` or via `registerCreator` in a library loaded with `--dynamicPlugins` /
   `trt.get_plugin_registry().load_library`. Data-dependent output sizes: `IExprBuilder::declareSizeTensor` (INT64
   in TRT 11). Samples: `samples/sampleNonZeroPlugin`, `samples/python/sample_plugin_v2_to_v3_migration`, the
   plugins in `plugin/` of the TensorRT repo.
4. **Torch-TensorRT**: register the op with `torch.library.custom_op` + `register_fake`, then
   `torch_tensorrt.dynamo.conversion.plugins.custom_op("ns::op", supports_dynamic_shapes=True)` generates the plugin
   and converter; or write a converter with `@dynamo_tensorrt_converter(torch.ops.aten.X.default)`.

Plugin rules: support FP16/FP32 (and INT8/FP8 if around quantized layers) and the formats TRT prefers; handle
dynamic shapes; never allocate in `enqueue` (use the workspace); never synchronize; launch on the given stream;
validate against the PyTorch reference op with random inputs at several shapes and dtypes; benchmark the plugin in
isolation (`nsys`) and in the engine (`--dumpProfile`).

## 4. Parallelism inside and across models

Agents usually miss these; check every model for them:
- **Independent branches in one graph** (multi-head, multi-scale, two-tower, sensor fusion): build with auxiliary
  streams (`config.max_aux_streams = N` / `--maxAuxStreams=N`) so TRT runs branches concurrently (the limit is per inference
  stream; 0 = least memory). Compare `device_memory_size_v2` and latency with and without, and confirm in Nsight Systems
  that kernels overlap.
- **Independent models or stages** (detector + tracker, encoder + decoder of different inputs): one execution
  context per engine/profile, each on its own CUDA stream, synchronized with CUDA events, not `cudaDeviceSynchronize`.
  `trtexec --infStreams=N` to measure.
- **Pipelining**: overlap host↔device copies (pinned memory, `cudaMemcpyAsync` on a copy stream) with compute of the
  previous frame; double-buffer inputs/outputs. Pre/post-processing on the GPU (CUDA kernels, CV-CUDA, NPP, VPI on
  Jetson) instead of NumPy on the CPU.
- **Batching**: batch frames/cameras when latency budget allows; profile throughput vs latency at several batch sizes.
- **CUDA graphs** for the steady-state loop (default in trtexec; in your code capture `enqueueV3` after the shapes are
  fixed). Not with data-dependent shapes, loops or conditionals.
- **DLA (AGX Orin)**: offload a second, DLA-friendly model (or the backbone) to DLA cores (`--useDLACore=0
  --allowGPUFallback`) to run concurrently with the GPU; check which layers fell back.
- **Multiple devices**: TRT 11 multi-device inference and collectives exist for large models; not typical on Jetson.

## 5. The optimization checklist (training → device)

Go through all of it; report what you checked, what you changed and the measured effect.

1. **Requirement**: target device + JetPack/TRT version, latency (p50/p99) or throughput target, batch size, input
   resolution, power mode, accuracy budget. Ask if unknown.
2. **Architecture** (cheapest wins first): input resolution and crop, channel widths, depth; replace ops that are
   slow or unsupported on TRT (e.g. some attention variants, dynamic indexing, exotic activations) with fused-friendly
   ones; static shapes where possible; avoid data-dependent shapes and Python control flow in the forward pass;
   prefer channels and sizes that are multiples of 8/16/32 (tensor cores); fuse normalization into conv/linear at
   export (BN folding).
3. **Training-aware**: QAT or sparsity-aware training (2:4 structured sparsity, `--sparsity=enable`) if PTQ or dense
   is not enough; distillation into a smaller student; pruning (ModelOpt).
4. **Export**: clean graph (constant folding, no redundant casts/reshapes, no unused outputs), newest opset,
   verify numerics (Polygraphy).
5. **Precision**: FP16/BF16 everywhere it is accurate; INT8/FP8/NVFP4 where hardware supports it; mixed precision for
   sensitive layers; measure accuracy.
6. **Engine build**: `--builderOptimizationLevel` (default 3; try 4–5 for production builds), a persistent timing
   cache, realistic `opt` shapes, `--memPoolSize` limits on small devices, weight stripping/refit if engines must be
   updated in the field, weight streaming only when weights exceed memory.
7. **Inspect**: `trtexec --profilingVerbosity=detailed --dumpLayerInfo --exportLayerInfo=layers.json --dumpProfile
   --exportProfile=prof.json` — look for unfused layers, reformat (`Reformat`/`Shuffle`) layers, FP32 fallbacks,
   slow plugins; fix in the model and repeat.
8. **Runtime**: parallelism (section 4), CUDA graphs, pinned memory, zero-copy/unified memory on Jetson (integrated
   GPU shares DRAM), GPU pre/post-processing, no per-frame allocations, no host syncs in the loop.
9. **System (Jetson)**: power mode `sudo nvpmodel -q / -m <id>`, `sudo jetson_clocks` (fixed clocks for benchmarks;
   note it pins the mode until reboot), thermal state, `tegrastats --interval 500` for GPU/EMC/DLA load and power,
   EMC (memory bandwidth) is often the real bottleneck.
10. **Measure honestly**: warm-up, many iterations, report p50/p90/p99 and throughput, power (tegrastats) and accuracy;
    same power mode and clocks for before/after; end-to-end (camera → result) as well as engine-only.

## 6. Benchmarking and profiling

```sh
trtexec --loadEngine=model.engine --warmUp=2000 --iterations=1000 --percentile=50,90,99  # warm-up in ms; engine-only latency
trtexec --loadEngine=model.engine --infStreams=2 --duration=30                             # concurrency
nsys profile -t cuda,nvtx,osrt -o run python app.py && nsys stats -r cuda_gpu_kern_sum --format csv run.nsys-rep
ncu --set full -k regex:<kernel> -c 1 -o k python app.py && ncu -i k.ncu-rep --csv --page details
```
On Jetson use Nsight Systems' Jetson support (or `nsys` on the device); Nsight Compute for one kernel at a time.
Add NVTX ranges around pre-process / inference / post-process in the application so timelines are readable.

## 7. LLMs/VLMs on the edge

Use **TensorRT Edge-LLM** (C++ runtime for Jetson; https://github.com/NVIDIA/TensorRT-Edge-LLM) or TensorRT-LLM on
larger GPUs rather than hand-building transformer engines; quantize weights (INT4 AWQ / FP8 / NVFP4 per hardware) with
ModelOpt; check its supported-model list for the version you install.

## 8. Experiment hygiene

Log every export/build/benchmark as an MLflow run (see the ml-training skill): model revision, ONNX hash, TRT and
JetPack versions, precision, builder flags, power mode, latency percentiles, accuracy, and the engine/layer-info files
as artifacts. Keep conversion and benchmark scripts in the repo (Pixi tasks), not as one-off shell history.
