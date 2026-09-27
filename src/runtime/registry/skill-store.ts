// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { SkillMetadata } from './filesystem-scanner.js'

export class SkillStore {
  private current: SkillMetadata[] = []

  getSkills(): SkillMetadata[] {
    return this.current
  }

  swap(newSkills: SkillMetadata[]): void {
    this.current = newSkills
  }
}
