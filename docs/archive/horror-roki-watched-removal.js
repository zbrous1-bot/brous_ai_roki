/**
 * Horror Roki - Watched Removal Helper (plain English version)
 *
 * Problem: When you mark a movie as "watched" (add it to Your Library),
 * it can still sit in the "Recommended for you" list until you manually
 * hit Recompute or refresh. This creates duplicates.
 *
 * Solution: Call this small function right after the user marks something watched.
 * It removes the item from whatever is currently on screen in the discover/recommendations.
 *
 * HOW TO USE (copy these steps into your Horror Roki code):
 *
 * 1. Make sure you have a way to track watched items.
 *    Example: an array or object called `yourLibrary` or `watchedItems`.
 *
 * 2. Also keep a Set of IDs for fast checking (recommended):
 *    let watchedIds = new Set();
 *
 *    Whenever you load or change the library, rebuild the Set:
 *    function rebuildWatchedIds() {
 *      watchedIds.clear();
 *      yourLibrary.forEach(item => {
 *        const key = item.id + ':' + (item.mediaType || 'movie');
 *        watchedIds.add(key);
 *      });
 *    }
 *
 * 3. Call this function immediately after adding something to the library:
 *
 *    removeFromCurrentDiscover(item.id, item.mediaType || 'movie');
 *
 * 4. If you have a "pool" (the raw list before filtering for Recompute),
 *    also filter the pool:
 *
 *    if (window.currentPool) {
 *      window.currentPool = window.currentPool.filter(i => {
 *        const k = i.id + ':' + (i.mediaType || 'movie');
 *        return !watchedIds.has(k);
 *      });
 *    }
 *
 * 5. Then re-draw the recommendation cards (call whatever function you use to render "Recommended for you").
 *
 * This file is a ready-to-adapt helper. Paste the removeFromCurrentDiscover function
 * into your main Horror Roki JavaScript and wire the call into your "mark as watched" code.
 */

// The actual function you can copy
function removeFromCurrentDiscover(id, mediaType = 'movie') {
  const key = id + ':' + mediaType;

  // If Horror Roki keeps a "currentRecommendations" or similar array for the visible list, filter it.
  if (window.currentRecommendations && Array.isArray(window.currentRecommendations)) {
    window.currentRecommendations = window.currentRecommendations.filter(item => {
      const itemKey = item.id + ':' + (item.mediaType || 'movie');
      return itemKey !== key;
    });
  }

  // If you have a raw pool that feeds recommendations, filter it too (good for Recompute).
  if (window.currentPool && Array.isArray(window.currentPool)) {
    window.currentPool = window.currentPool.filter(item => {
      const itemKey = item.id + ':' + (item.mediaType || 'movie');
      return itemKey !== key;
    });
  }

  // Re-render the visible recommendation section.
  // Change the function name below to whatever you actually use to draw the cards.
  if (typeof window.renderRecommended === 'function') {
    if (window.currentRecommendations) {
      window.renderRecommended(window.currentRecommendations);
    } else if (window.currentPool) {
      window.renderRecommended(window.currentPool);
    }
  } else if (typeof window.recomputeRecommendations === 'function') {
    // Fallback: trigger a full recompute (it should now see the updated watched list).
    window.recomputeRecommendations();
  } else {
    console.warn('[Horror Roki] Could not find a render function for recommendations. You may need to call your render function manually after removeFromCurrentDiscover.');
  }
}

// Optional: also clean any search results that are currently visible
function removeFromCurrentSearch(id, mediaType = 'movie') {
  const key = id + ':' + mediaType;

  if (window.lastSearchResults && Array.isArray(window.lastSearchResults)) {
    window.lastSearchResults = window.lastSearchResults.filter(item => {
      const itemKey = item.id + ':' + (item.mediaType || 'movie');
      return itemKey !== key;
    });
  }

  if (typeof window.renderSearchResults === 'function' && window.lastSearchResults) {
    window.renderSearchResults(window.lastSearchResults);
  }
}

console.log('%c[Horror Roki] Watched removal helper ready. Call removeFromCurrentDiscover(id, mediaType) right after adding to the library.', 'color:#4ade80');