<template>
<DirectorScenesPanel
          :popular-blueprint-pool="popularBlueprintPool"
          :blueprint-categories="blueprintCategories"
          :recommended-blueprints="recommendedBlueprints"
          :filtered-popular-blueprints="filteredPopularBlueprints"
          :popular-category="popularCategory"
          :show-all-blueprints="showAllBlueprints"
          :available-scenes="availableScenes"
          :visible-scenes="visibleScenes"
          :scene-collection="sceneCollection"
          :persona-core-count="personaCoreCount"
          :curated-count="curatedCount"
          :persona-core-ids="personaCoreIds"
          :scene-limit="sceneLimit"
          @update:popularCategory="popularCategory = $event"
          @update:showAllBlueprints="showAllBlueprints = $event"
          @selectBlueprint="selectBlueprint"
          @rotateBlueprintSet="rotateBlueprintSet"
          @toggleBlueprintList="toggleBlueprintList"
          @update:sceneCollection="setSceneCollection($event)"
          @selectScene="selectScene"
          @update:sceneLimit="sceneLimit = $event"
          @retry="bindings.retryInitialization"
        />
</template>

<script setup lang="ts">
import DirectorScenesPanel from './DirectorScenesPanel.vue'
import type { PromptMaterialBindings } from '@/composables/prompt/promptPanelBindings'
const props = defineProps<{ bindings: PromptMaterialBindings }>()
const { popularBlueprintPool, blueprintCategories, recommendedBlueprints, filteredPopularBlueprints, popularCategory, showAllBlueprints, availableScenes, visibleScenes, sceneCollection, personaCoreCount, curatedCount, personaCoreIds, sceneLimit, selectBlueprint, rotateBlueprintSet, toggleBlueprintList, setSceneCollection, selectScene } = props.bindings
</script>
