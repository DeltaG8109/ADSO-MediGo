module.exports = {
  async up(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable("doctor_schedule_exceptions", {
      id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true, allowNull: false },
      doctor_id: {
        type: DataTypes.BIGINT.UNSIGNED, allowNull: false,
        references: { model: "doctors", key: "id" }, onUpdate: "CASCADE", onDelete: "RESTRICT"
      },
      starts_at: { type: DataTypes.DATE(3), allowNull: false },
      ends_at: { type: DataTypes.DATE(3), allowNull: false },
      reason: { type: DataTypes.STRING(255), allowNull: false },
      status: { type: DataTypes.ENUM("ACTIVE", "INACTIVE"), allowNull: false, defaultValue: "ACTIVE" },
      created_at: { type: DataTypes.DATE(3), allowNull: false },
      updated_at: { type: DataTypes.DATE(3), allowNull: false }
    });
    await queryInterface.addIndex("doctor_schedule_exceptions",
      ["doctor_id", "status", "starts_at", "ends_at"],
      { name: "doctor_schedule_exceptions_doctor_status_period_idx" });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("doctor_schedule_exceptions");
  }
};
