<!--
  Copyright 2026 The Ray Optics Simulation authors and contributors

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
-->

<template>
  <div class="modal fade" id="galleryModal" data-bs-backdrop="false" data-bs-keyboard="false" tabindex="-1" aria-labelledby="staticBackdropLabel_gallery" aria-hidden="true">
    <div class="modal-backdrop fade" :class="{ show: isModalOpen }" @click="closeModal"></div>
    <div class="modal-dialog modal-dialog-centered modal-xl gallery-modal-dialog">
      <div class="modal-content gallery-modal-content">
        <div class="modal-header">
          <h5 class="modal-title" id="staticBackdropLabel_gallery" v-text="$t('simulator:galleryModal.title')"></h5>
          <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
        </div>
        <div class="modal-body gallery-modal-body">
          <div class="gallery-modal-toolbar">
            <input
              v-model="searchText"
              class="form-control gallery-modal-search"
              type="search"
              :placeholder="$t('simulator:galleryModal.searchPlaceholder')"
              :aria-label="$t('simulator:galleryModal.searchPlaceholder')"
            >
            <span class="gallery-modal-count" v-text="$t('simulator:galleryModal.count', { shown: filteredItems.length, total: totalItemCount })"></span>
          </div>

          <div class="gallery-modal-layout">
            <div class="gallery-modal-categories" role="tablist" :aria-label="$t('simulator:galleryModal.categories')">
              <button
                v-for="category in categoryOptions"
                :key="category.id"
                type="button"
                class="gallery-modal-category"
                :class="{ active: selectedCategory === category.id }"
                @click="selectedCategory = category.id"
              >
                <span class="gallery-modal-category-title" v-text="category.title"></span>
                <span class="gallery-modal-category-count" v-text="category.count"></span>
              </button>
            </div>

            <div class="gallery-modal-list" role="list">
              <button
                v-for="item in filteredItems"
                :key="item.id"
                type="button"
                class="gallery-modal-item"
                @click="openDemo(item.id)"
              >
                <span class="gallery-modal-item-main">
                  <span class="gallery-modal-item-title" v-text="item.title"></span>
                  <sup v-if="item.beta" class="gallery-modal-beta">Beta</sup>
                </span>
                <span class="gallery-modal-item-meta">
                  <span v-text="item.categoryTitle"></span>
                  <span aria-hidden="true">/</span>
                  <span v-text="item.id"></span>
                </span>
              </button>
              <div v-if="filteredItems.length === 0" class="gallery-modal-empty" v-text="$t('simulator:galleryModal.empty')"></div>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" data-bs-dismiss="modal" v-html="$t('simulator:common.closeButton')"></button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
/**
 * @module GalleryModal
 * @description Internal picker for bundled Gallery scenes.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import * as bootstrap from 'bootstrap'
import i18next from 'i18next'
import { app } from '../services/app.js'
import { getGalleryCatalog } from '../services/gallerySamples.js'

const catalog = getGalleryCatalog()
const allItems = catalog.flatMap((category) => category.items)

export default {
  name: 'GalleryModal',
  setup() {
    const isModalOpen = ref(false)
    const searchText = ref('')
    const selectedCategory = ref('all')
    const totalItemCount = allItems.length

    const categoryOptions = computed(() => [
      {
        id: 'all',
        title: i18next.t('simulator:galleryModal.all'),
        count: totalItemCount
      },
      ...catalog.map((category) => ({
        id: category.id,
        title: category.title,
        count: category.items.length
      }))
    ])

    const filteredItems = computed(() => {
      const query = searchText.value.trim().toLowerCase()
      return allItems.filter((item) => {
        if (selectedCategory.value !== 'all' && item.categoryId !== selectedCategory.value) {
          return false
        }

        if (!query) {
          return true
        }

        return [
          item.title,
          item.id,
          item.categoryTitle,
          item.contributors.join(' ')
        ].some((value) => value.toLowerCase().includes(query))
      })
    })

    const closeModal = () => {
      const modal = document.getElementById('galleryModal')
      const modalInstance = bootstrap.Modal.getInstance(modal)
      if (modalInstance) {
        modalInstance.hide()
      } else {
        modal.classList.remove('show')
        modal.setAttribute('aria-hidden', 'true')
        modal.style.display = 'none'
        isModalOpen.value = false
      }
    }

    const openDemo = (id) => {
      if (app.openGallerySample(id)) {
        closeModal()
      }
    }

    const showGalleryModal = () => {
      const modal = document.getElementById('galleryModal')
      bootstrap.Modal.getOrCreateInstance(modal).show()
    }

    onMounted(() => {
      const modal = document.getElementById('galleryModal')
      modal.addEventListener('show.bs.modal', () => { isModalOpen.value = true })
      modal.addEventListener('hide.bs.modal', () => { isModalOpen.value = false })
      window.addEventListener('rayOpticsOpenGallery', showGalleryModal)
    })

    onUnmounted(() => {
      window.removeEventListener('rayOpticsOpenGallery', showGalleryModal)
    })

    return {
      isModalOpen,
      searchText,
      selectedCategory,
      categoryOptions,
      filteredItems,
      totalItemCount,
      closeModal,
      openDemo
    }
  }
}
</script>

<style scoped>
.gallery-modal-dialog {
  max-width: min(980px, calc(100vw - 24px));
  z-index: 1060;
}

.gallery-modal-content {
  max-height: min(760px, calc(100vh - 40px));
}

.gallery-modal-body {
  display: flex;
  min-height: 0;
  flex-direction: column;
  gap: 12px;
  overflow: hidden;
}

.gallery-modal-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
}

.gallery-modal-search {
  min-width: 180px;
}

.gallery-modal-count {
  flex: 0 0 auto;
  color: #555;
  font-size: 0.875rem;
}

.gallery-modal-layout {
  display: grid;
  min-height: 0;
  grid-template-columns: 210px minmax(0, 1fr);
  gap: 14px;
}

.gallery-modal-categories,
.gallery-modal-list {
  min-height: 0;
  overflow-y: auto;
}

.gallery-modal-categories {
  display: flex;
  max-height: min(560px, calc(100vh - 220px));
  flex-direction: column;
  gap: 4px;
  padding-right: 4px;
}

.gallery-modal-category {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  padding: 7px 9px;
  color: #222;
  text-align: left;
}

.gallery-modal-category:hover,
.gallery-modal-category.active {
  border-color: rgba(13, 110, 253, 0.28);
  background: rgba(13, 110, 253, 0.08);
}

.gallery-modal-category-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gallery-modal-category-count {
  flex: 0 0 auto;
  color: #666;
  font-size: 0.8rem;
}

.gallery-modal-list {
  display: grid;
  max-height: min(560px, calc(100vh - 220px));
  grid-auto-rows: minmax(58px, auto);
  gap: 6px;
  padding-right: 4px;
}

.gallery-modal-item {
  display: flex;
  width: 100%;
  min-width: 0;
  flex-direction: column;
  justify-content: center;
  gap: 3px;
  border: 1px solid #d7dbe0;
  border-radius: 6px;
  background: #fff;
  padding: 8px 10px;
  color: #222;
  text-align: left;
}

.gallery-modal-item:hover,
.gallery-modal-item:focus {
  border-color: #0d6efd;
  background: #f7fbff;
}

.gallery-modal-item-main,
.gallery-modal-item-meta {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 6px;
}

.gallery-modal-item-title {
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gallery-modal-beta {
  color: rgba(0, 0, 0, 0.45);
}

.gallery-modal-item-meta {
  color: #666;
  font-family: monospace;
  font-size: 0.8rem;
}

.gallery-modal-empty {
  padding: 24px 8px;
  color: #666;
  text-align: center;
}

@media (max-width: 720px) {
  .gallery-modal-toolbar,
  .gallery-modal-layout {
    display: flex;
    flex-direction: column;
  }

  .gallery-modal-categories {
    max-height: none;
    flex-direction: row;
    overflow-x: auto;
    overflow-y: hidden;
    padding-bottom: 4px;
  }

  .gallery-modal-category {
    width: auto;
    flex: 0 0 auto;
  }
}
</style>
