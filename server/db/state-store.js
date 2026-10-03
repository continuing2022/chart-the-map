function timestamp(value) {
  return value ? new Date(value).getTime() : null
}

function dateKey(value) {
  if (typeof value === 'string') return value.slice(0, 10)
  return new Date(value).toISOString().slice(0, 10)
}

function assetFromRow(row) {
  return {
    id: row.id,
    owner: row.owner_id,
    clientRecordId: row.client_record_id || '',
    objectKey: row.object_key,
    mimeType: row.mime_type,
    width: row.width,
    height: row.height,
    boundMealId: row.bound_meal_id || '',
    kind: row.kind,
    deleted: Boolean(row.deleted_at),
    createdAt: timestamp(row.created_at)
  }
}

function mealFromRow(row) {
  return {
    id: row.id,
    owner: row.owner_id,
    clientRecordId: row.client_record_id,
    dateKey: dateKey(row.date_key),
    slotKey: row.slot_key,
    style: row.style,
    note: row.note,
    originalAssetId: row.original_asset_id,
    nutrition: row.nutrition,
    candidateNutrition: row.candidate_nutrition,
    manuallyConfirmed: row.manually_confirmed,
    deleting: row.deleting,
    deleted: Boolean(row.deleted_at),
    tasks: {},
    usedTaskClientIds: { stylization: new Set(), nutrition: new Set() }
  }
}

function taskFromRow(row) {
  return {
    id: row.id,
    type: row.type,
    clientTaskId: row.client_task_id,
    status: row.status,
    createdAt: timestamp(row.created_at),
    completedAt: timestamp(row.completed_at),
    error: row.error,
    result: row.result
  }
}

async function hydrateState(pool, state) {
  const [assetsResult, mealsResult, tasksResult, costsResult] = await Promise.all([
    pool.query('SELECT * FROM assets'),
    pool.query('SELECT * FROM meals'),
    pool.query('SELECT * FROM processing_tasks ORDER BY created_at'),
    pool.query('SELECT owner_id, COALESCE(SUM(amount_cny), 0)::float8 AS total FROM cost_ledger GROUP BY owner_id')
  ])

  state.assets.clear()
  state.uploadsByClientId.clear()
  state.meals.clear()
  state.mealsByClientId.clear()
  state.costsByOwner.clear()

  for (const row of assetsResult.rows) {
    const asset = assetFromRow(row)
    state.assets.set(asset.id, asset)
    if (asset.kind === 'original' && asset.clientRecordId) {
      state.uploadsByClientId.set(`${asset.owner}:${asset.clientRecordId}`, asset.id)
    }
  }
  for (const row of mealsResult.rows) {
    const meal = mealFromRow(row)
    state.meals.set(meal.id, meal)
    state.mealsByClientId.set(`${meal.owner}:${meal.clientRecordId}`, meal.id)
  }
  for (const row of tasksResult.rows) {
    const meal = state.meals.get(row.meal_id)
    if (!meal) continue
    meal.usedTaskClientIds[row.type].add(row.client_task_id)
    if (row.is_current) meal.tasks[row.type] = taskFromRow(row)
  }
  for (const row of costsResult.rows) state.costsByOwner.set(row.owner_id, Number(row.total))
}

async function insertAsset(pool, asset) {
  await pool.query(`
    INSERT INTO assets (
      id, owner_id, client_record_id, object_key, mime_type, width, height,
      kind, bound_meal_id, created_at, deleted_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,to_timestamp($10 / 1000.0),$11)
  `, [
    asset.id, asset.owner, asset.clientRecordId || null, asset.objectKey, asset.mimeType,
    asset.width, asset.height, asset.kind, asset.boundMealId || null, asset.createdAt,
    asset.deleted ? new Date() : null
  ])
}

async function markAssetDeleted(pool, asset) {
  await pool.query('UPDATE assets SET deleted_at = COALESCE(deleted_at, now()) WHERE id = $1', [asset.id])
}

function taskValues(task) {
  return [
    task.id, task.type, task.clientTaskId, task.status,
    task.result ? JSON.stringify(task.result) : null,
    task.error ? JSON.stringify(task.error) : null,
    task.createdAt, task.completedAt ? new Date(task.completedAt) : null
  ]
}

async function createMeal(pool, meal, asset, costs) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`
      INSERT INTO meals (
        id, owner_id, client_record_id, date_key, slot_key, style, note,
        original_asset_id, nutrition, candidate_nutrition, manually_confirmed,
        deleting, deleted_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,false,NULL)
    `, [
      meal.id, meal.owner, meal.clientRecordId, meal.dateKey, meal.slotKey, meal.style,
      meal.note, meal.originalAssetId, meal.nutrition, meal.candidateNutrition,
      meal.manuallyConfirmed
    ])
    await client.query('UPDATE assets SET bound_meal_id = $1 WHERE id = $2 AND owner_id = $3', [meal.id, asset.id, meal.owner])
    for (const type of ['stylization', 'nutrition']) {
      const task = meal.tasks[type]
      const values = taskValues(task)
      await client.query(`
        INSERT INTO processing_tasks (
          id, meal_id, type, client_task_id, status, is_current, result, error,
          created_at, completed_at
        ) VALUES ($1,$2,$3,$4,$5,true,$6,$7,to_timestamp($8 / 1000.0),$9)
      `, [values[0], meal.id, ...values.slice(1)])
      await client.query(
        'INSERT INTO cost_ledger (owner_id, task_id, amount_cny) VALUES ($1,$2,$3)',
        [meal.owner, task.id, costs[type]]
      )
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function persistMeal(pool, meal) {
  await pool.query(`
    UPDATE meals SET
      style = $2,
      note = $3,
      nutrition = $4,
      candidate_nutrition = $5,
      manually_confirmed = $6,
      deleting = $7,
      updated_at = now(),
      deleted_at = CASE WHEN $8 THEN COALESCE(deleted_at, now()) ELSE deleted_at END
    WHERE id = $1
  `, [
    meal.id, meal.style, meal.note, meal.nutrition, meal.candidateNutrition,
    meal.manuallyConfirmed, Boolean(meal.deleting), Boolean(meal.deleted)
  ])
}

async function persistTask(pool, meal, task) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`
      UPDATE processing_tasks SET
        status = $2,
        result = $3,
        error = $4,
        completed_at = $5,
        lease_expires_at = NULL
      WHERE id = $1
    `, [
      task.id, task.status, task.result ? JSON.stringify(task.result) : null,
      task.error ? JSON.stringify(task.error) : null,
      task.completedAt ? new Date(task.completedAt) : null
    ])
    await client.query(`
      UPDATE meals SET nutrition = $2, candidate_nutrition = $3,
        manually_confirmed = $4, updated_at = now()
      WHERE id = $1
    `, [meal.id, meal.nutrition, meal.candidateNutrition, meal.manuallyConfirmed])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function retryTask(pool, meal, oldTask, newTask, amount) {
  const values = taskValues(newTask)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (oldTask) await client.query('UPDATE processing_tasks SET is_current = false WHERE id = $1', [oldTask.id])
    await client.query(`
      INSERT INTO processing_tasks (
        id, meal_id, type, client_task_id, status, is_current, result, error,
        created_at, completed_at
      ) VALUES ($1,$2,$3,$4,$5,true,$6,$7,to_timestamp($8 / 1000.0),$9)
    `, [values[0], meal.id, ...values.slice(1)])
    await client.query(
      'INSERT INTO cost_ledger (owner_id, task_id, amount_cny) VALUES ($1,$2,$3)',
      [meal.owner, newTask.id, amount]
    )
    await client.query('UPDATE meals SET style = $2, updated_at = now() WHERE id = $1', [meal.id, meal.style])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function finishMealDeletion(pool, meal, assets) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const asset of assets) {
      await client.query('UPDATE assets SET deleted_at = COALESCE(deleted_at, now()) WHERE id = $1', [asset.id])
    }
    await client.query('UPDATE meals SET deleting = false, deleted_at = COALESCE(deleted_at, now()), updated_at = now() WHERE id = $1', [meal.id])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

module.exports = {
  createMeal,
  finishMealDeletion,
  hydrateState,
  insertAsset,
  markAssetDeleted,
  persistMeal,
  persistTask,
  retryTask
}
