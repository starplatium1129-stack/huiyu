<template>
  <details class="manager-summary">
    <summary>场景概况 · {{ scenesCount }} 条</summary>
    <!-- Stats: 4 groups — 总览 / 角色 / 分级 / Tags -->
    <div class="stats">
      <div class="stat-group stat-group--overview">
        <div class="stat-card stat-card--accent">
          <div class="stat-value">{{ stats[0]?.value }}</div>
          <div class="stat-label">{{ stats[0]?.label }}</div>
        </div>
      </div>
      <div class="stat-group stat-group--chars">
        <div class="stat-card stat-card--amber">
          <div class="stat-value">{{ stats[1]?.value }}</div>
          <div class="stat-label">{{ stats[1]?.label }}</div>
        </div>
        <div class="stat-card stat-card--accent">
          <div class="stat-value">{{ stats[2]?.value }}</div>
          <div class="stat-label">{{ stats[2]?.label }}</div>
        </div>
        <div class="stat-card stat-card--muted">
          <div class="stat-value">{{ stats[3]?.value }}</div>
          <div class="stat-label">{{ stats[3]?.label }}</div>
        </div>
      </div>
      <div class="stat-group stat-group--rating">
        <div class="stat-card stat-card--success">
          <div class="stat-value">{{ stats[4]?.value }}</div>
          <div class="stat-label">{{ stats[4]?.label }}</div>
        </div>
        <div class="stat-card stat-card--warning">
          <div class="stat-value">{{ stats[5]?.value }}</div>
          <div class="stat-label">{{ stats[5]?.label }}</div>
        </div>
      </div>
      <div class="stat-group stat-group--tags">
        <div class="stat-card stat-card--muted">
          <div class="stat-value">{{ stats[6]?.value }}</div>
          <div class="stat-label">{{ stats[6]?.label }}</div>
        </div>
        <div class="stat-card stat-card--muted">
          <div class="stat-value">{{ stats[7]?.value }}</div>
          <div class="stat-label">{{ stats[7]?.label }}</div>
        </div>
      </div>
    </div>
  </details>
</template>

<script setup lang="ts">
defineProps<{
  scenesCount: number
  stats: Array<{ label?: string; value?: string | number }>
}>()
</script>
