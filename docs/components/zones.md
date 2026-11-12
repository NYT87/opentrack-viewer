# Zones (reserved)

A zone component would show the zone bounds (heart rate, power or pace zones) and the zone the activity
is in now. **It is reserved.** There is no props type, no adapter and no section for it, because what a
zone is (its bounds, where they come from, how the reader edits them) is decided by
[issue #20](https://github.com/NYT87/opentrack-viewer/issues/20), and a shape written now would only
change then.

When #20 lands this page gets its props table, its units and an example, as the other sections have, and
`ContractSection` gains `zones`. Until then a component cannot ask for zones.
