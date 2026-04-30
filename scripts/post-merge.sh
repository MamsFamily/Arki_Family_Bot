#!/bin/bash
set -e

# Post-merge setup — installe les dépendances Node.js
npm install --prefer-offline 2>/dev/null || npm install
