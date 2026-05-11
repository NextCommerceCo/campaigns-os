# Versioning

This repo uses independent compatibility versions:

- package version: `0.1.0-alpha.0`
- Build Packet: `campaign-runtime-build-packet/v0`
- Build Context: `campaign-runtime-build-context/v0`
- Assembly Report: `campaign-runtime-assembly-report/v0`
- CampaignSpec: `4.2`
- starter-template agent contract: `1`
- commerce surface catalog: `2`

Breaking packet semantics should create a new packet schema version. Non-breaking doctor warnings can ship in package patch/minor releases during dogfood.
