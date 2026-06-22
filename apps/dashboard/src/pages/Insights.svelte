<script lang="ts">
  import { t } from '../lib/i18n';
</script>

<h1>{t('insights.title')}</h1>
<div class="soon muted">{t('insights.soon')}</div>

<style>
  h1 {
    font-size: 22px;
    margin-bottom: 18px;
  }
  .soon {
    padding: 48px 0;
    text-align: center;
    border: 1px dashed var(--line);
    border-radius: var(--radius);
  }
</style>
