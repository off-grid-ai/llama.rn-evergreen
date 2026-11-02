# Hexagon (HTP0): Qwen 3.5 output is garbage

Qwen 3.5 0.8B Q4_0 on the Hexagon backend (HTP0, `-ngl 99`) produces garbage. The same GGUF on CPU is correct. Parked: Ali reports the NPU output was always garbled, so this is **not a b12032 regression** and does not block releases. This issue records where the investigation stopped.

## Device
OnePlus Nord 5 (CPH2707), SM8635. ggml-hexagon autodetects the arch below v75 (logs `forcing ndev to 1 for SoCs archs lower than v75`) and loads `libggml-htp-v73.so`.

## Reproduction (upstream llama.cpp, no app involved)
Built with the dispatch-only **Hexagon probe** workflow (`.github/workflows/hexagon-probe.yml`, run 41420128875). It builds upstream with its own `arm64-android-snapdragon-release` preset and toolchain image.

```sh
export LD_LIBRARY_PATH=$PWD/lib ADSP_LIBRARY_PATH=$PWD/lib
./bin/llama-completion -m Qwen3.5-0.8B-Q4_0.gguf --device HTP0 -ngl 99 --temp 0 -n 32 -no-cnv --no-warmup \
  -p "The three primary colors of light are red, green and"
```

| Build | HTP0 | CPU (`--device none`) |
| --- | --- | --- |
| b12032 | ` alikeuela \| \| 2024 \| 2025 ...` | ` blue.` (correct) |
| b12032 with da6c30ade (transposed CONCAT / SSM_CONV / GDN rewrite) reverted | same garbage | — |
| 8642541b (llama.cpp v0.8.0, the base of llama.rn 0.13.0-rc.9) | same garbage | — |

So the HTP output is wrong for this model at both llama.cpp versions. Only 6 ggml-hexagon commits separate them (522021325, 2e0d86beb, da6c30ade, 8a199ad31, 418f905a4, a91eab67d). Upstream has no hexagon commit after b12032 as of 2026-11-02.

## test-backend-ops -b HTP0 (b12032, partial, stopped early)
- OK: elementwise and GLU ops, fused ADD_*_MUL, GET_ROWS (88), SET_ROWS (55), ROPE_SET_ROWS (69), IM2COL (113), IM2COL_3D (1539), POOL_1D (216).
- FAIL: GET_ROWS q4_K/q5_K at ~3e-7 (threshold 1e-7; probably harmless); POOL_2D with k0=128 (inf / large error); CEIL (4 cases); many CONV_2D cases with dilation/stride (ERR=inf).
- **Not reached:** MUL_MAT, CONCAT, SSM_CONV, GATED_DELTA_NET, L2_NORM, FLASH_ATTN_EXT, SOFT_MAX. These are the ops Qwen 3.5's hybrid (Gated DeltaNet + attention) graph uses.

## Next steps
1. Run `test-backend-ops test -b HTP0 -o <OP>` for MUL_MAT, CONCAT, SSM_CONV, GATED_DELTA_NET, L2_NORM, FLASH_ATTN_EXT and SOFT_MAX to find the wrong op.
2. Or bisect by op: `GGML_HEXAGON_OPMASK` / disable ops in `ggml_backend_hexagon_device_supports_op` one at a time until the HTP output matches CPU.
3. Check whether `GGML_HEXAGON_ARCH=v75` changes anything on SM8635, in case the arch probe is wrong.
4. Also run a pure-attention model (Qwen3-0.6B) to separate the recurrent-op path from MUL_MAT/attention.
