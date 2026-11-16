---
name: jarvis-anatomy
description: Prepare or revise a reusable 3D structure demonstration for the Jarvis desktop app, including named parts, geometry, assembly positions and exploded positions.
---

Add the prepared object to `src/data/anatomy.json` in the Jarvis workspace. Use the existing coffee machine and keyboard as examples. Give the object a display name and aliases that a user would type or say after “拆解一下”. Include the display name as an alias and avoid aliases already used by other objects.

Build the model around its center. Each part has a name, a short Chinese explanation, a three-axis assembled center and a three-axis displacement used when expanded. Each shape is a tuple of kind, center relative to its part, and dimensions. For a box these are full widths on X, Y and Z. For a cylinder they are X radius, full height, and Z radius. The keys primitive fills the bounds with an illustrative key grid. Y is up and positive Z faces forward. Keep the model and expanded arrangement within the existing camera bounds or extend the viewer if the object requires new geometry.

Keep the chassis, base, or equivalent assembly reference in place when appropriate. Move panels and internal parts along a small number of axes that reflect their relationship to the assembly. For a layered object, preserve the layer order on a common axis. The viewer draws dashed lines from assembled centers to expanded parts, so check the assembled centers as well as the expanded positions. Add a short Chinese `guide` to explain how to read the arrangement.

Use verifiable reference material when depicting a specific real model. Use representative parts and avoid model-specific claims for generic diagrams. Check that names match the depicted geometry and that parts remain distinguishable in the default expanded view.

Run `npm run web:build`. Open the object by its spoken name and verify the assembled view, expansion, part labels and descriptions, rotation, and reassembly. The app loads the prepared catalog directly from the bundle after a rebuild.
