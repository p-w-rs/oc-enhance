---
name: ml-training
description: Train and evaluate models reproducibly on NVIDIA and AMD GPUs — Pixi environments for CUDA and ROCm PyTorch, MLflow 3 experiment tracking (runs, params, metrics, system metrics, LoggedModels, comparing runs), long runs on remote GPU machines, mixed precision, torch.compile, distributed training, checkpoints, and planning for deployment from the start. Load before setting up training, running experiments or comparing results.
---

# Training and experiments

## Environment

- One Pixi workspace per project, committed with `pixi.lock`. NVIDIA and AMD in **separate environments**:
  - `cuda`: conda-forge `pytorch-gpu` + `cuda-version = "13.*"` on a platform that declares CUDA
    (`platforms = [{ platform = "linux-64", cuda = "13.0" }]`; `[system-requirements]` is the deprecated form).
  - `rocm`: PyTorch ROCm wheels via PyPI (`torch = { version = "…", index = "https://download.pytorch.org/whl/rocm<ver>" }`);
    conda-forge has no ROCm PyTorch. Check https://pytorch.org/get-started for the current index names.
- Verify on the machine before blaming code: `pixi run -e cuda python -c "import torch; print(torch.__version__,
  torch.version.cuda, torch.cuda.is_available(), torch.cuda.get_device_name())"` (ROCm: `torch.version.hip`; AMD GPUs
  still use the `torch.cuda` API). Driver vs toolkit: `nvidia-smi` / `rocm-smi`.
- Code stays device-agnostic: `device = "cuda"`, no `nvidia-smi` parsing in training code, no CUDA-only libraries
  without a fallback, and test the ROCm environment in CI or on an AMD box when AMD support matters.

## MLflow (default experiment tracker)

Use MLflow for every training, evaluation, export and benchmark run (MLflow 3.x; check `mlflow --version`).

- Add `mlflow` (conda-forge) to the project. Local server: `pixi run mlflow server` (UI and API at
  http://127.0.0.1:5000; default backend `sqlite:///mlflow.db`, artifacts in `./mlartifacts`; the old `./mlruns`
  file store is being deprecated). A shared server: set `MLFLOW_TRACKING_URI` (and `MLFLOW_TRACKING_TOKEN` or
  username/password if it needs auth; never hard-code them). Remote access needs `--host 0.0.0.0 --allowed-hosts …`.
- Logging:
  ```python
  import mlflow
  mlflow.set_experiment("detector-v2")                 # or MLFLOW_EXPERIMENT_NAME
  with mlflow.start_run(run_name="r50-640px-fp16", log_system_metrics=True):   # GPU util/memory every 10 s
      mlflow.log_params({"lr": lr, "batch": bs, "precision": "bf16", "git_sha": sha, "data_rev": data_rev})
      for step, metrics in train():
          mlflow.log_metrics(metrics, step=step)
      mlflow.log_artifact("config.yaml")
      info = mlflow.pytorch.log_model(model, name="model", step=step)   # MLflow 3: LoggedModel, load via info.model_uri
  ```
  System metrics need `psutil` and `nvidia-ml-py` (NVIDIA) or `pyrsmi` (AMD). `mlflow.pytorch.autolog()` covers
  Lightning only; plain loops log manually. In MLflow 3 use `name=` (not `artifact_path=`) and `models:/<model_id>`
  URIs; `runs:/<run_id>/model` is deprecated.
- Tag every run with what makes it reproducible: git commit (and dirty flag), Pixi lock hash, dataset revision
  (e.g. Hugging Face dataset sha), seed, hardware (GPU, driver, CUDA/ROCm version).
- Compare instead of eyeballing logs: `mlflow.search_runs(experiment_names=["detector-v2"], filter_string="metrics.val_map
  > 0.5 and params.precision = 'bf16'", order_by=["metrics.val_map DESC"])` (a DataFrame), or `mlflow runs list` /
  `mlflow experiments search` on the CLI. Report the comparison table to the user.
- Deployment runs (ONNX/TensorRT/benchmarks, see ml-deploy) go in the same experiment or a linked one, with the parent
  training run id as a tag.

## Long runs on GPU machines

- Run on the remote machine (oc-machine SSH aliases, RunPod pods, Azure VMs) inside `tmux new -d -s train '…'` or
  `nohup … > train.log 2>&1 &`, not in a foreground shell that dies with the connection. Check with `tail -n 50
  train.log`, `nvidia-smi` / `rocm-smi`, and the MLflow UI. Copy results back with rsync.
- Checkpoint regularly (model, optimizer, scheduler, scaler, RNG state, step) and support resuming; log checkpoint
  paths. Stop paid machines when done (the RunPod/Azure plugins track running cost).

## Training performance

- Mixed precision: `torch.autocast(dtype=torch.bfloat16)` on Ampere+/MI200+ (no grad scaler), FP16 with `GradScaler`
  otherwise. TF32 for FP32 matmuls on NVIDIA: `torch.backends.cuda.matmul.allow_tf32 = True`.
- `torch.compile(model)` (check graph breaks with `TORCH_LOGS=graph_breaks`), channels-last for convnets, fused
  optimizers (`fused=True`), `pin_memory=True` and enough `num_workers`, `non_blocking=True` copies.
- Find the bottleneck before optimizing: data loading vs GPU (GPU util in system metrics, the PyTorch profiler,
  `nsys`). Multi-GPU: `torchrun` + DDP first; FSDP2 when the model doesn't fit.

## Plan for deployment while training

If the model will run on an edge device (see ml-deploy): pick ops that TensorRT supports and fuses, keep shapes static
or bounded, avoid data-dependent control flow, use sizes that are multiples of 8/16, export to ONNX early and often
(a CI check), and consider QAT/sparsity-aware fine-tuning if INT8/FP8 PTQ loses accuracy. Evaluate the exported/
quantized model's accuracy, not only the PyTorch model's.
