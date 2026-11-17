module.exports = {
  async up(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable("consultation_addenda", {
      id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true, allowNull: false },
      consultation_id: {
        type: DataTypes.BIGINT.UNSIGNED, allowNull: false,
        references: { model: "consultations", key: "id" }, onUpdate: "CASCADE", onDelete: "RESTRICT"
      },
      doctor_id: {
        type: DataTypes.BIGINT.UNSIGNED, allowNull: false,
        references: { model: "doctors", key: "id" }, onUpdate: "CASCADE", onDelete: "RESTRICT"
      },
      content: { type: DataTypes.TEXT, allowNull: false },
      created_at: { type: DataTypes.DATE(3), allowNull: false }
    });
    await queryInterface.addIndex("consultation_addenda", ["consultation_id", "created_at"], {
      name: "consultation_addenda_consultation_created_idx"
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("consultation_addenda");
  }
};
