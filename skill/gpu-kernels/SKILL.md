---
name: gpu-kernels
description: Write, port and tune custom GPU kernels for NVIDIA and AMD — Triton (autotune, tensor descriptors/TMA, AMD wavefronts), CUDA C++ and HIP (hipify), CUTLASS/CuTe, PyTorch custom ops (torch.library.custom_op, triton_op) that work with torch.compile and export, correctness testing and benchmarking, and profiling with Nsight Systems/Compute and rocprofv3. Load before writing or optimizing any kernel.
---

# Custom GPU kernels (NVIDIA and AMD)

## Ground truth first

- Check versions on the machine that will run the kernel: `nvidia-smi` / `nvcc --version` (CUDA), `rocminfo | grep
  gfx` / `hipcc --version` (ROCm), `python -c "import torch, triton; print(torch.__version__, torch.version.cuda,
  torch.version.hip, triton.__version__)"`, and the GPU's architecture (compute capability `torch.cuda.get_device_capability()`
  or `gfx…`). Shared-memory size, warp/wavefront width and tensor-core features depend on it.
- APIs move fast (Triton especially). Read the docs/tutorials for the installed version before writing code:
  https://triton-lang.org/main/ (tutorials and `python-api`), https://docs.nvidia.com/cuda/ (programming guide,
  release notes), https://rocm.docs.amd.com/ (HIP, HIPIFY, rocprofiler), https://docs.pytorch.org/docs/main/library.html.
  As of November 2026: Triton 3.9 (NVIDIA cc 8.0+, AMD ROCm 6.2+), CUDA 13.5, ROCm 10.1, PyTorch 2.15, CUTLASS 4.8.
  Verify; don't trust these numbers.

## Which tool

1. **Don't write a kernel** if `torch.compile` (Inductor), a library (cuBLAS/hipBLASLt, cuDNN/MIOpen, FlashAttention,
   `scaled_dot_product_attention`) or TensorRT fusion already does it. Profile first; write kernels for the measured
   hot spots only.
2. **Triton** by default: one source for NVIDIA and AMD, autotuning, integrates with `torch.compile` and TensorRT
   (AOT plugins). Good for fused element-wise/reduction/normalization/attention-like and custom GEMM epilogues.
3. **CUDA C++ / HIP** when you need warp-level control, inline PTX, specific tensor-core instructions, or a C++
   runtime without Python (TensorRT C++ plugins, embedded). Write HIP-portable CUDA where possible and port with
   `hipify-clang` (accurate; needs CUDA headers) or `hipify-perl` (quick regex).
4. **CUTLASS / CuTe (C++ or the CuTe Python DSL)** for high-performance GEMM/conv variants on NVIDIA (Hopper/Blackwell
   TMA, warp specialization). Triton's **Gluon** is the lower-level option inside Triton for Blackwell.

## Triton practices

```python
@triton.autotune(configs=[triton.Config({"BLOCK_M": 128, "BLOCK_N": 128, "BLOCK_K": 64}, num_warps=8, num_stages=3), ...],
                 key=["M", "N", "K"])
@triton.jit
def kernel(a_ptr, b_ptr, c_ptr, M, N, K, stride_am, ..., BLOCK_M: tl.constexpr, BLOCK_N: tl.constexpr, BLOCK_K: tl.constexpr): ...
```
- Autotune over block sizes, `num_warps` and `num_stages`; key on the shape dimensions that change. AMD wavefronts are
  64 wide: tune `num_warps` separately and include AMD-friendly configs (AMD also has `waves_per_eu`, `matrix_instr_nonkdim`
  kwargs; check the docs).
- Use **tensor descriptors** (`tl.make_tensor_descriptor` / host `TensorDescriptor`) for block loads: they map to TMA on
  Hopper/Blackwell (2–5 dims, 16-byte aligned base, contiguous last dim). Block pointers still work.
- Masks for boundaries, `tl.multiple_of`/`tl.max_contiguous` hints, accumulate in FP32, cast at the store. Fuse the
  epilogue (bias, activation, residual, quantization) instead of separate kernels.
- Debug: `TRITON_INTERPRET=1` (CPU interpreter), `TRITON_KERNEL_DUMP=1 TRITON_DUMP_DIR=…` to see IR/PTX/AMDGCN.

## PyTorch integration

- Triton kernels: `@torch.library.triton_op("mylib::op", mutates_args={})` and launch with `wrap_triton(kernel)[grid](…)`
  so `torch.compile`, `torch.export` and AOTInductor can trace through it; kernels used in backward must also be wrapped.
- Other kernels (CUDA/HIP extensions): `@torch.library.custom_op("mylib::op", mutates_args=())`, plus
  `.register_fake` (shape/dtype only; required for compile/export), `.register_autograd` for gradients, and validate with
  `torch.library.opcheck`. Build C++/CUDA extensions with `torch.utils.cpp_extension` or CMake in a Pixi environment.
- The same custom op can become a TensorRT plugin for deployment (see the ml-deploy skill).

## Correctness and speed (every kernel)

- Test against a reference (PyTorch eager, FP32/FP64) over random inputs, several shapes (including non-multiples of the
  block size and size 1), dtypes, strides/non-contiguous inputs; tolerances appropriate to the dtype
  (`torch.testing.assert_close`). Test both NVIDIA and AMD when supporting both.
- Benchmark with `triton.testing.do_bench` or CUDA events (warm-up, many reps, synchronize), report achieved bandwidth
  (GB/s) or FLOP/s against the device's peak, and compare to the baseline it replaces (PyTorch eager and `torch.compile`).
- Profile: NVIDIA `nsys profile -t cuda,nvtx -o r …` → `nsys stats --format csv -r cuda_gpu_kern_sum r.nsys-rep`;
  per-kernel `ncu --set full -k regex:name -c 1 -o k …` → `ncu -i k.ncu-rep --csv --page details` (look at memory
  throughput, achieved occupancy, warp stall reasons, bank conflicts). AMD `rocprofv3 --kernel-trace --stats -d out --
  python …` (output is a rocpd SQLite db; convert with `rocpd convert … --output-format csv`), deeper analysis with
  `rocprof-compute profile/analyze`. Read results as text; don't guess.

## Environments (Pixi)

- NVIDIA: conda-forge `pytorch-gpu` with `cuda-version = "13.*"` and a CUDA-declaring platform
  (`platforms = [{ platform = "linux-64", cuda = "13.0" }]`), plus `triton`, `cuda-nvcc`, `cuda-cudart-dev` for
  extensions. AMD: PyTorch ROCm wheels from the PyPI index in a separate feature/environment
  (`torch = { version = "...", index = "https://download.pytorch.org/whl/rocm<ver>" }`; conda-forge has no ROCm PyTorch).
  Keep CUDA and ROCm in separate Pixi environments (`pixi run -e cuda …`, `pixi run -e rocm …`).
- Select GPUs with `CUDA_VISIBLE_DEVICES` (NVIDIA) / `HIP_VISIBLE_DEVICES` (AMD; ROCm PyTorch also honors the CUDA one).
