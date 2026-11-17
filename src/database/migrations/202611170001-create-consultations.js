module.exports = {
  async up(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable("consultations", {
      id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true, allowNull: false },
      appointment_id: {
        type: DataTypes.BIGINT.UNSIGNED, allowNull: false, unique: true,
        references: { model: "appointments", key: "id" }, onUpdate: "CASCADE", onDelete: "RESTRICT"
      },
      doctor_id: {
        type: DataTypes.BIGINT.UNSIGNED, allowNull: false,
        references: { model: "doctors", key: "id" }, onUpdate: "CASCADE", onDelete: "RESTRICT"
      },
      status: { type: DataTypes.ENUM("IN_PROGRESS", "COMPLETED"), allowNull: false, defaultValue: "IN_PROGRESS" },
      notes: { type: DataTypes.TEXT, allowNull: true },
      started_at: { type: DataTypes.DATE(3), allowNull: false },
      completed_at: { type: DataTypes.DATE(3), allowNull: true },
      created_at: { type: DataTypes.DATE(3), allowNull: false },
      updated_at: { type: DataTypes.DATE(3), allowNull: false }
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("consultations");
  }
};
