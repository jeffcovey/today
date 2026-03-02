// Shared health metric definitions
// Used by bin/health and plugins that need health metric mappings

export const METRIC_DISPLAY = {
  // Activity
  step_count: { emoji: '👟', label: 'Steps', format: v => Math.round(v).toLocaleString() },
  distance_walking_running: { emoji: '🚶', label: 'Distance', format: v => `${v.toFixed(2)} mi` },
  walking_running_distance: { emoji: '🚶', label: 'Walk/Run', format: v => `${v.toFixed(2)} mi` },
  cycling_distance: { emoji: '🚴', label: 'Cycling', format: v => `${v.toFixed(2)} mi` },
  active_energy: { emoji: '🔥', label: 'Active Cal', format: v => `${Math.round(v)} kcal` },
  basal_energy_burned: { emoji: '🔋', label: 'Basal Cal', format: v => `${Math.round(v)} kcal` },
  apple_exercise_time: { emoji: '🏃', label: 'Exercise', format: v => `${Math.round(v)} min` },
  apple_stand_hour: { emoji: '🧍', label: 'Stand Hours', format: v => `${Math.round(v)}` },
  apple_stand_time: { emoji: '🧍', label: 'Stand Time', format: v => `${Math.round(v)} min` },
  flights_climbed: { emoji: '🪜', label: 'Flights', format: v => `${Math.round(v)}` },
  physical_effort: { emoji: '💪', label: 'Effort', format: v => `${v.toFixed(1)} kcal/hr·kg` },

  // Walking metrics
  walking_speed: { emoji: '🚶', label: 'Walk Speed', format: v => `${v.toFixed(1)} mph` },
  walking_step_length: { emoji: '📏', label: 'Step Length', format: v => `${v.toFixed(1)} in` },
  walking_asymmetry_percentage: { emoji: '📐', label: 'Walk Asymmetry', format: v => `${v.toFixed(1)}%` },
  walking_double_support_percentage: { emoji: '🦶', label: 'Double Support', format: v => `${v.toFixed(1)}%` },
  walking_heart_rate_average: { emoji: '💗', label: 'Walk HR', format: v => `${Math.round(v)} bpm` },

  // Body
  weight_body_mass: { emoji: '🏋', label: 'Weight', format: v => `${v.toFixed(1)} lbs` },
  body_fat_percentage: { emoji: '📊', label: 'Body Fat', format: v => `${v.toFixed(1)}%` },
  body_mass_index: { emoji: '📊', label: 'BMI', format: v => `${v.toFixed(1)}` },
  lean_body_mass: { emoji: '💪', label: 'Lean Mass', format: v => `${v.toFixed(1)} lbs` },

  // Heart
  heart_rate: { emoji: '💗', label: 'Heart Rate', format: v => `${Math.round(v)} bpm` },
  resting_heart_rate: { emoji: '💓', label: 'Resting HR', format: v => `${Math.round(v)} bpm` },
  heart_rate_variability_sdnn: { emoji: '📈', label: 'HRV', format: v => `${Math.round(v)} ms` },
  heart_rate_variability: { emoji: '📈', label: 'HRV', format: v => `${Math.round(v)} ms` },
  respiratory_rate: { emoji: '💨', label: 'Resp Rate', format: v => `${v.toFixed(1)} /min` },
  blood_oxygen_saturation: { emoji: '🩸', label: 'SpO2', format: v => `${(v * 100).toFixed(0)}%` },

  // Sleep & mindfulness
  sleep_analysis: { emoji: '😴', label: 'Sleep', format: v => `${v.toFixed(1)} hrs` },
  mindful_minutes: { emoji: '🧘', label: 'Mindful', format: v => `${Math.round(v)} min` },
  time_in_daylight: { emoji: '🌞', label: 'Daylight', format: v => `${Math.round(v)} min` },

  // Audio
  environmental_audio_exposure: { emoji: '🔊', label: 'Env Audio', format: v => `${v.toFixed(0)} dB` },
  headphone_audio_exposure: { emoji: '🎧', label: 'Headphone', format: v => `${v.toFixed(0)} dB` },

  // Nutrition - hydration
  dietary_water: { emoji: '💧', label: 'Water', format: v => `${v.toFixed(1)} L` },
  dietary_caffeine: { emoji: '☕', label: 'Caffeine', format: v => `${Math.round(v)} mg` },
  alcohol_consumption: { emoji: '🍷', label: 'Alcohol', format: v => `${v.toFixed(1)} drinks` },

  // Nutrition - macros
  dietary_energy: { emoji: '🍴', label: 'Calories', format: v => `${Math.round(v)} kcal` },
  protein: { emoji: '🥩', label: 'Protein', format: v => `${v.toFixed(0)} g` },
  carbohydrates: { emoji: '🍞', label: 'Carbs', format: v => `${v.toFixed(0)} g` },
  total_fat: { emoji: '🧈', label: 'Fat', format: v => `${v.toFixed(0)} g` },
  saturated_fat: { emoji: '🧈', label: 'Sat Fat', format: v => `${v.toFixed(0)} g` },
  monounsaturated_fat: { emoji: '🫒', label: 'Mono Fat', format: v => `${v.toFixed(0)} g` },
  polyunsaturated_fat: { emoji: '🐟', label: 'Poly Fat', format: v => `${v.toFixed(0)} g` },
  fiber: { emoji: '🥦', label: 'Fiber', format: v => `${v.toFixed(0)} g` },
  dietary_sugar: { emoji: '🍬', label: 'Sugar', format: v => `${v.toFixed(0)} g` },
  cholesterol: { emoji: '🫀', label: 'Cholesterol', format: v => `${Math.round(v)} mg` },
  sodium: { emoji: '🧂', label: 'Sodium', format: v => `${Math.round(v)} mg` },

  // Nutrition - vitamins
  vitamin_a: { emoji: '💊', label: 'Vitamin A', format: v => `${v.toFixed(0)} mcg` },
  vitamin_b6: { emoji: '💊', label: 'Vitamin B6', format: v => `${v.toFixed(2)} mg` },
  vitamin_b12: { emoji: '💊', label: 'Vitamin B12', format: v => `${v.toFixed(1)} mcg` },
  vitamin_c: { emoji: '🍊', label: 'Vitamin C', format: v => `${v.toFixed(0)} mg` },
  vitamin_d: { emoji: '🌞', label: 'Vitamin D', format: v => `${v.toFixed(0)} mcg` },
  vitamin_e: { emoji: '💊', label: 'Vitamin E', format: v => `${v.toFixed(1)} mg` },
  vitamin_k: { emoji: '💊', label: 'Vitamin K', format: v => `${v.toFixed(1)} mcg` },
  thiamin: { emoji: '💊', label: 'Thiamin', format: v => `${v.toFixed(2)} mg` },
  riboflavin: { emoji: '💊', label: 'Riboflavin', format: v => `${v.toFixed(2)} mg` },
  niacin: { emoji: '💊', label: 'Niacin', format: v => `${v.toFixed(1)} mg` },
  folate: { emoji: '💊', label: 'Folate', format: v => `${v.toFixed(0)} mcg` },
  pantothenic_acid: { emoji: '💊', label: 'B5', format: v => `${v.toFixed(1)} mg` },

  // Nutrition - minerals
  calcium: { emoji: '🦴', label: 'Calcium', format: v => `${Math.round(v)} mg` },
  iron: { emoji: '🩸', label: 'Iron', format: v => `${v.toFixed(1)} mg` },
  magnesium: { emoji: '💎', label: 'Magnesium', format: v => `${Math.round(v)} mg` },
  phosphorus: { emoji: '💎', label: 'Phosphorus', format: v => `${Math.round(v)} mg` },
  potassium: { emoji: '🍌', label: 'Potassium', format: v => `${Math.round(v)} mg` },
  zinc: { emoji: '💎', label: 'Zinc', format: v => `${v.toFixed(1)} mg` },
  copper: { emoji: '💎', label: 'Copper', format: v => `${v.toFixed(2)} mg` },
  manganese: { emoji: '💎', label: 'Manganese', format: v => `${v.toFixed(2)} mg` },
  selenium: { emoji: '💎', label: 'Selenium', format: v => `${v.toFixed(1)} mcg` },
};