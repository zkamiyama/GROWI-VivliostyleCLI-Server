## Vivliostyle CLI Log Level

The server exposes Vivliostyle CLI logging via the `--log-level` flag.

- Accepts: `silent`, `info`, `verbose`, `debug`
- Frontend may pass this as `cliOptions.logLevel` (JSON API) or inside
  `cliOptions` (stringified JSON) for the multipart API.
- If the frontend does not specify a level, the server defaults to `debug`
  and runs Vivliostyle with `--log-level debug`.
- If `cliOptions.additionalArgs` includes an explicit `--log-level`, that
  explicit value is respected.

Example JSON request fragment:

```
{
  "sourceArchive": "<BASE64_ZIP>",
  "cliOptions": {
    "logLevel": "verbose"
  }
}
```

