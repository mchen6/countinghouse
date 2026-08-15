# `spec/`

## `schema.json` — live

The meta-schema every device module's `api.json` is validated against at load
time (`lib/validator.js` compiles it with ajv). This is the 5.0.0 format:
`actionList` is an array of actions that carry their own `name` and their own
`input`/`output`/`fault` schema pointers. See
[`docs/module-development.md`](https://github.com/mchen6/countinghouse/blob/master/docs/module-development.md)
to write against it and [`MIGRATION.md`](../MIGRATION.md) for what changed
from 4.x.

## Everything else here — historical

`BasicDevice.json`, `BinaryLight.json`, `DimmableLight.json`, `SensorHub.json`,
`onvif.json`, `spec.json` and `tools/` are example device descriptions from the
CDIF 3.x era, when this project modelled physical UPnP/ONVIF devices. Nothing
loads them: they are not modules (no `index.js`/`device.js`), and no code path
reads them.

They are **in the pre-5.0.0 format on purpose** and are not converted. Several
of them cannot be: they declare scalar state variables (`dataType: "string"`,
`allowedValueRange`, `sendEvents`) that describe device state a controller
subscribes to, which 5.0.0 has no representation for — an action argument is
now always a JSON Schema document, and state variables are gone entirely.
Rewriting them would mean inventing 5.0.0 documents for devices this runtime no
longer targets, which would be worse than leaving the originals legible.

Kept because the lineage is part of what this project is (see the README's
credit to CDIF), and because `tools/onvif/process.js` records how the ONVIF
WSDL was mechanically turned into a device spec. Read them as history, not as
examples to copy.
