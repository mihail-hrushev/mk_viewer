# glTF extension `MK_property_table` (version 1)

Node properties of a glTF file as one table instead of per-node `extras` objects. Written by the
MK Navisworks plugin's glTF / GLB export, read by the built-in glTF loader
(`src/loaders/gltf/GltfLoader.ts`). Engineering exports have many nodes but few distinct property
keys and comparatively few distinct values, so listing each once and storing rows as integers is a
fraction of the size of the same data as JSON objects (a 166,792-node precast model: 59 MB instead
of 221 MB).

It is a root extension, listed in `extensionsUsed` and not in `extensionsRequired`: a reader without
it still shows the geometry.

```json
"extensionsUsed": ["MK_property_table"],
"extensions": {
  "MK_property_table": {
    "version": 1,
    "keys":   [["Item", "Name"], ["SmartPlant 3D", "Weight"]],
    "values": ["Pipe 1", 12.5, true, "2024-05-01T00:00:00.0000000"],
    "nodeStart": 12,
    "key": 13,
    "value": 14
  }
}
```

| member | content |
| --- | --- |
| `version` | `1`. Other versions are ignored (one console warning, a model warning) and node `extras` are used. |
| `keys` | distinct `[category, property]` pairs: display names, any strings (dots and spaces allowed) |
| `values` | distinct values with their JSON type: string, number or boolean. No `null`; empty values are not written. The string `"1"` and the number `1` are different values. |
| `nodeStart` | accessor, SCALAR, UNSIGNED_INT, count `nodes.length + 1`: the rows of glTF node `i` are `nodeStart[i] .. nodeStart[i+1] - 1` (empty for a node without properties) |
| `key` | accessor, SCALAR, one per row: index into `keys`. UNSIGNED_SHORT when `keys.length <= 65535`, else UNSIGNED_INT; readers use the accessor's `componentType`. |
| `value` | accessor, SCALAR, UNSIGNED_INT, one per row: index into `values` |

The accessors live in the normal buffers / bufferViews (no `target`).

Rows of a node are in display order: categories in order, properties in order within each
category; a `(category, property)` pair appears at most once per node.

## Meaning

The properties of node `i` are the object

```js
{ [category]: { [property]: value } }   // for each row r of node i: keys[key[r]] = [category, property], values[value[r]]
```

exactly what node `extras` would hold. In the viewer they behave as such: the Properties panel
groups them by category, the search keys are `Category.Property`, and
`hierarchy.properties(node, inherited)` merges ancestors by category (a nearer node's category
replaces the ancestor's).

## Reader rules (this viewer)

- A node with rows takes its properties from the table; its `extras` are not read. A node with an
  empty range keeps its `extras`, if it has any (writers put no property `extras` on nodes when the
  table is present).
- `model.getProperties(objectId).extras` is the decoded table object for nodes with rows.
- An inconsistent table (`nodeStart` count is not `nodes.length + 1`, decreasing, more rows than the
  `key` / `value` accessors hold, an index out of range, `keys` not string pairs) is ignored with a
  model warning, and `extras` are used.
- The typed arrays are kept (zero-copy views on the GLB binary chunk when aligned) and a node's
  object is built only when it is asked for; the property index is built from the rows directly.
- With `keepNames: false` the table is not read.
